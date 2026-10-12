import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { masterCredentials, contentCredentials, newContentSecret, newToken, seal, sealedWire, open } from '../src/crypto.js';
import { newOrigin } from '../src/core.js';
import { fixture } from './server.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function until(predicate) {
  for (let i = 0; i < 600; i++) { if (predicate()) return; await sleep(5); }
  assert.fail('Timed out waiting for synthetic operation');
}
function observeCrypto(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), real = globalThis.crypto;
  const calls = [], hooks = {}, plaintexts = [], imports = [], decrypted = [];
  const subtle = new Proxy(real.subtle, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => {
      calls.push({ method: key, algorithm: args[0]?.name ?? args[2] });
      if (key === 'importKey' && args[0] === 'raw') imports.push(args[1]);
      if (key === 'encrypt') plaintexts.push({ bytes: args[2], text: new TextDecoder().decode(args[2]) });
      const run = () => Reflect.apply(target[key], target, args);
      const result = hooks[key] ? hooks[key](args, run) : run();
      return key === 'decrypt' ? Promise.resolve(result).then(buffer => { decrypted.push(new Uint8Array(buffer)); return buffer; }) : result;
    };
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: array => real.getRandomValues(array) } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', original));
  return { real, calls, hooks, plaintexts, imports, decrypted };
}
async function setup(t) {
  const server = await fixture();
  const clients = [], traces = [];
  const client = () => {
    const transport = new SocketIoTransport(server.url, { timeout: 500, allowInsecureLocalhost: true });
    transport.on('trace', record => traces.push(record));
    const ulda = new Ulda(server.url, { transport, reconnect: false });
    ulda.on('trace', record => traces.push(record));
    clients.push(ulda); return ulda;
  };
  t.after(async () => { for (const ulda of clients) await ulda.close(); await server.close(); });
  const ulda = client(), password = 'synthetic-lifecycle-password';
  const masterId = await ulda.register(password);
  await ulda.add('note', { value: 1, key: 'application-owned-key-field' });
  return { server, ulda, client, traces, password, masterId };
}
const zero = bytes => assert.ok(bytes.every(byte => byte === 0), 'Owned temporary bytes were not wiped');

test('KDF/import and plaintext buffers are wiped; AES keys cannot export or wrap', async t => {
  const spy = observeCrypto(t);
  const master = await masterCredentials('synthetic-only'), content = await contentCredentials(newContentSecret());
  spy.imports.forEach(zero);
  const wrapping = await spy.real.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey']);
  for (const credentials of [master, content]) {
    assert.equal(credentials.key.extractable, false);
    await assert.rejects(spy.real.subtle.exportKey('raw', credentials.key));
    await assert.rejects(spy.real.subtle.wrapKey('raw', credentials.key, wrapping, 'AES-KW'));
    const token = newToken();
    const wire = sealedWire(await seal(credentials, token, newOrigin(), { private: 'synthetic-plaintext' }));
    assert.equal((await open(credentials, wire, token)).data.private, 'synthetic-plaintext');
    await assert.rejects(open(credentials, wire, newToken()), { code: 'CRYPTO_FAILED' });
  }
  spy.plaintexts.forEach(({ bytes }) => zero(bytes));
  spy.decrypted.forEach(zero);
});

for (const failure of ['importKey', 'deriveKey', 'encrypt']) test(`Temporary secret bytes are wiped on ${failure} failure`, async t => {
  const spy = observeCrypto(t);
  const credentials = await contentCredentials(newContentSecret());
  spy.hooks[failure] = () => Promise.reject(new Error('synthetic crypto failure'));
  if (failure === 'encrypt') await assert.rejects(seal(credentials, newToken(), newOrigin(), { marker: 'private' }), { code: 'CRYPTO_FAILED' });
  else {
    await assert.rejects(masterCredentials('synthetic-only'));
    await assert.rejects(contentCredentials(newContentSecret()));
  }
  spy.imports.forEach(zero);
  spy.plaintexts.forEach(({ bytes }) => zero(bytes));
});

test('Refresh/reconnect reuse the master key; public APIs and diagnostics exclude private SDK state', async t => {
  const spy = observeCrypto(t);
  const { ulda, traces, password } = await setup(t);
  const derivedBefore = spy.calls.filter(call => call.method === 'deriveKey' && call.algorithm === 'PBKDF2').length;
  await ulda.refresh(); await ulda.reconnect(); await ulda.update('note', { value: 2 });
  assert.equal(spy.calls.filter(call => call.method === 'deriveKey' && call.algorithm === 'PBKDF2').length, derivedBefore);
  assert.equal(derivedBefore, 1);
  assert.deepEqual(Reflect.ownKeys(ulda), []);
  assert.equal(JSON.stringify(ulda), '{}');
  const copy = ulda.snapshot(); copy.note.value = 999;
  assert.equal(ulda.value('note').value, 2);
  const visible = JSON.stringify({ snapshot: ulda.snapshot(), traces });
  const secrets = [password];
  for (const { text } of spy.plaintexts) {
    const container = JSON.parse(text);
    secrets.push(container.token, container.origin);
    for (const entry of container.data?.contents ?? []) secrets.push(entry.key, entry.token);
  }
  for (const secret of secrets) assert.equal(visible.includes(secret), false);
  spy.imports.forEach(zero); spy.plaintexts.forEach(({ bytes }) => zero(bytes)); spy.decrypted.forEach(zero);
});

for (const operation of ['add-create', 'add-update', 'update', 'delete', 'superDelete']) test(`Close clears context before server ACK and cannot be reversed by pending ${operation}`, { timeout: 10000 }, async t => {
  const { ulda, server, traces } = await setup(t);
  const ref = ulda.ref('note'), oldGet = ref.get, oldUpdate = ref.update, tree = ulda.data;
  const copy = ulda.snapshot();
  let releaseWrite, releaseClose;
  const action = operation === 'add-create' ? 'create' : operation.includes('update') || operation === 'update' ? 'update' : 'delete';
  server.faults.push({ action, holdAck: release => { releaseWrite = release; } });
  server.faults.push({ action: 'session.close', holdAck: release => { releaseClose = release; } });
  const pending = operation.startsWith('add') ? ulda.add('other', { value: 2 }) : operation === 'update' ? ulda.update('note', { value: 2 }) :
    operation === 'delete' ? ulda.delete('note') : ulda.superDelete();
  const result = pending.then(() => 'unexpected success', error => error.code);
  await until(() => !!releaseWrite);
  const clearingBefore = traces.filter(trace => trace.step === 'session.clear').length;
  const closing = ulda.close();
  assert.equal(closing, ulda.close());
  assert.equal(traces.filter(trace => trace.step === 'session.clear').length, clearingBefore + 1);
  assert.equal(ulda.status, 'closed');
  assert.throws(() => ulda.snapshot(), { code: 'CLOSED' });
  assert.throws(() => oldGet(), { code: 'STALE_REFERENCE' });
  assert.throws(() => oldUpdate({ value: 3 }), { code: 'STALE_REFERENCE' });
  assert.throws(() => tree.note, { code: 'STALE_REFERENCE' });
  assert.ok(['CLOSED', 'UNKNOWN_OUTCOME'].includes(await result));
  assert.equal(ulda.status, 'closed');
  await until(() => !!releaseClose);
  const start = server.frames.length;
  releaseWrite(); releaseClose(); await closing; await sleep(25);
  assert.equal(ulda.status, 'closed');
  assert.equal(server.frames.slice(start).some(frame => ['create', 'update', 'delete'].includes(frame.action)), false);
  assert.equal(copy.note.value, 1); // Copies already given to the application remain its responsibility.
  assert.throws(() => ulda.on('trace', () => {}), { code: 'CLOSED' });
});

for (const method of ['register', 'connect']) test(`Close during ${method} KDF prevents subsequent encryption/decryption and network writes`, { timeout: 10000 }, async t => {
  const { server, client, password, masterId } = await setup(t);
  const spy = observeCrypto(t), waiting = gate();
  let held = false;
  spy.hooks.deriveKey = async (args, run) => {
    const key = await run();
    if (args[0].name === 'PBKDF2') { held = true; await waiting.promise; }
    return key;
  };
  const ulda = client();
  const start = server.frames.length;
  const pending = (method === 'register' ? ulda.register(password) : ulda.connect(masterId, password)).then(() => 'success', error => error.code);
  await until(() => held); spy.imports.forEach(zero);
  await ulda.close(); waiting.release();
  assert.equal(await pending, 'CLOSED');
  assert.equal(spy.calls.some(call => call.method === 'encrypt' || call.method === 'decrypt'), false);
  assert.equal(server.frames.slice(start).some(frame => ['create', 'update', 'delete'].includes(frame.action)), false);
});

test('Close during encryption rejects the preparing write immediately and never sends its candidate', { timeout: 10000 }, async t => {
  const { ulda, server } = await setup(t);
  const spy = observeCrypto(t), waiting = gate();
  let held = false;
  spy.hooks.encrypt = async (args, run) => { const result = await run(); held = true; await waiting.promise; return result; };
  const start = server.frames.length;
  const pending = ulda.update('note', { value: 9 }).then(() => 'success', error => error.code);
  await until(() => held);
  await ulda.close();
  assert.equal(await pending, 'CLOSED');
  waiting.release(); await sleep(30);
  spy.plaintexts.forEach(({ bytes }) => zero(bytes));
  assert.equal(server.frames.slice(start).some(frame => frame.action === 'update'), false);
});

test('Wrong password leaves no open context and a later explicit login uses new credentials', async t => {
  const { client, password, masterId } = await setup(t), ulda = client();
  await assert.rejects(ulda.connect(masterId, 'synthetic-wrong-password'), { code: 'CRYPTO_FAILED' });
  assert.throws(() => ulda.snapshot(), { code: 'NOT_OPEN' });
  assert.equal(JSON.stringify(ulda), '{}');
  await ulda.reconnect(); await ulda.connect(masterId, password);
  assert.equal(ulda.value('note').value, 1);
});

test('A reference to deleted content cannot silently address a new resource with the same name', async t => {
  const { ulda } = await setup(t);
  const ref = ulda.ref('note'), get = ref.get, update = ref.update;
  await ulda.delete('note'); await ulda.add('note', { value: 100 });
  assert.throws(() => get(), { code: 'STALE_REFERENCE' });
  assert.throws(() => update({ value: -1 }), { code: 'STALE_REFERENCE' });
  assert.equal(ulda.value('note').value, 100);
});

test('KDF failures expose a fixed code, not the underlying exception text', async t => {
  const { client } = await setup(t), ulda = client(), spy = observeCrypto(t);
  const marker = 'synthetic-private-error-marker';
  spy.hooks.deriveKey = () => Promise.reject(new Error(marker));
  await assert.rejects(ulda.register(marker), error => {
    assert.equal(error.code, 'CRYPTO_FAILED');
    assert.equal(String(error).includes(marker), false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  });
  spy.imports.forEach(zero);
});

test('Close while the first master Read is pending cancels login before KDF', async t => {
  const { server, client, password, masterId } = await setup(t);
  const ulda = client(), spy = observeCrypto(t);
  let release;
  server.faults.push({ action: 'read', holdAck: fn => { release = fn; } });
  const pending = ulda.connect(masterId, password).then(() => 'success', error => error.code);
  await until(() => !!release);
  await ulda.close();
  assert.equal(await pending, 'CLOSED');
  release(); await sleep(30);
  assert.equal(spy.calls.some(call => call.method === 'deriveKey'), false);
  assert.equal(ulda.status, 'closed');
});
