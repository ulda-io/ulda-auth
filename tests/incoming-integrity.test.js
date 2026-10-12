import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda } from '../src/index.js';
import { newOrigin, advance } from '../src/core.js';
import { masterCredentials, contentCredentials, newContentSecret, newToken,
  seal, sealedWire, envelope, open } from '../src/crypto.js';
import { b64, concat, utf8, random } from '../src/values.js';
import { fixture } from './server.js';

// Test-only construction with a known synthetic key: AEAD is valid but the
// plaintext origin does not match the public witness. This does NOT imply that
// a server lacking the key can forge AES-GCM. It isolates the SDK's inner check.
async function inconsistentOrigin(credentials, record, token, data, mode = 'X') {
  const header = envelope(record.payload).header, nonce = random(12);
  const plaintext = utf8(JSON.stringify({ token, origin: b64(newOrigin(mode)), data }));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
      iv: nonce, additionalData: concat(utf8('ULDA-SDK/container/v2\0'), header, record.witness),
      tagLength: 128 }, credentials.key, plaintext));
    return { ...record, payload: concat(header, nonce, ciphertext) };
  } finally { plaintext.fill(0); }
}

for (const mode of ['X', 'S']) test(`Authenticated ${mode} plaintext still requires sign(origin) to match witness`, async () => {
  const credentials = await contentCredentials(newContentSecret()), token = newToken();
  const record = { id: '1', ...sealedWire(await seal(credentials, token, newOrigin(mode), { value: 1 })) };
  const inconsistent = await inconsistentOrigin(credentials, record, token, { value: 2 }, mode);
  await assert.rejects(open(credentials, inconsistent, token), { code: 'CRYPTO_FAILED' });
  assert.equal((await open(credentials, record, token)).data.value, 1);
});

test('First login without a local anchor rejects authenticated but inconsistent origin; no destructive recovery', async t => {
  const server = await fixture(), ulda = new Ulda(server.url, { allowInsecureLocalhost: true });
  t.after(async () => { await ulda.close(); await server.close(); });
  const password = 'synthetic-incoming-integrity-password';
  const credentials = await masterCredentials(password), token = newToken();
  const record = { id: '1', ...sealedWire(await seal(credentials, token, newOrigin('X'), { contents: [] })) };
  const inconsistent = await inconsistentOrigin(credentials, record, token, { contents: [] });
  server.records.set('1', inconsistent);
  await assert.rejects(ulda.connect('1', password), { code: 'CRYPTO_FAILED' });
  assert.throws(() => ulda.snapshot(), { code: 'NOT_OPEN' });
  assert.equal(server.frames.some(x => ['create', 'update', 'delete'].includes(x.action)), false);
  assert.equal(server.records.get('1'), inconsistent);
});

test('Bad Read, delete preflight and Changed preserve the verified copy and never trigger Create/Delete', { timeout: 5000 }, async t => {
  const server = await fixture(), ulda = new Ulda(server.url, { allowInsecureLocalhost: true });
  t.after(async () => { await ulda.close(); await server.close(); });
  const masterId = await ulda.register('synthetic-preserve-last-good-password');
  await ulda.add('notes', { value: 1 });
  const record = [...server.records.values()].find(x => x.id !== masterId);
  const payload = record.payload.slice(); payload[payload.length - 1] ^= 1;
  const invalid = { ...record, payload };
  const start = server.frames.length;
  const badRead = () => server.faults.push({ action: 'read', match: body => body.includes(record.id),
    response: () => ({ ok: true, data: [invalid] }) });
  badRead();
  await assert.rejects(ulda.refresh(), { code: 'CRYPTO_FAILED' });
  assert.equal(ulda.value('notes').value, 1);
  assert.equal(ulda.status, 'needsResync');
  await assert.rejects(ulda.delete('notes'), { code: 'NEEDS_RESYNC' });
  await ulda.refresh();
  badRead();
  await assert.rejects(ulda.delete('notes'), { code: 'CRYPTO_FAILED' });
  assert.equal(ulda.value('notes').value, 1);
  const fault = new Promise(resolve => ulda.on('error', resolve));
  server.sendChanged({ updated: [invalid], deleted: [] });
  assert.equal((await fault).code, 'CRYPTO_FAILED');
  assert.equal(ulda.status, 'needsResync');
  assert.equal(ulda.value('notes').value, 1);
  assert.equal(server.records.get(record.id), record);
  assert.equal(server.frames.slice(start).some(x => ['create', 'update', 'delete'].includes(x.action)), false);
});

function damaged(record) {
  const payload = record.payload.slice();
  payload[payload.length - 1] ^= 1;
  return { ...record, payload };
}

async function scenario(t, count = 2) {
  const server = await fixture(), clients = [];
  const client = () => {
    const ulda = new Ulda(server.url, { allowInsecureLocalhost: true, timeout: 3000 });
    const trace = [], changes = [];
    ulda.on('trace', event => trace.push(event));
    ulda.on('change', event => changes.push(event));
    clients.push(ulda);
    return { ulda, trace, changes };
  };
  t.after(async () => {
    for (const ulda of clients) await ulda.close();
    await server.close();
  });
  const a = client(), password = 'synthetic-batch-integrity-password';
  const masterId = await a.ulda.register(password);
  for (let i = 0; i < count; i++) await a.ulda.add(`item-${i}`, { value: 0 });
  // Known test credentials let the fixture model genuine remote writes, then
  // damage one ciphertext in transit. The server cannot do this without keys.
  const masterRecord = server.records.get(masterId);
  const credentials = await masterCredentials(password, envelope(masterRecord.payload).salt);
  const master = await open(credentials, masterRecord);
  a.trace.length = a.changes.length = 0;
  return { server, client, a, masterId, password, master, credentials };
}

async function successor(entry, record, value) {
  const credentials = await contentCredentials(entry.key, envelope(record.payload).salt);
  const state = await open(credentials, record, entry.token);
  return { id: entry.id, ...sealedWire(await seal(credentials, state.token, advance(state.origin), value)) };
}

function noWritesSince(server, start) {
  assert.equal(server.frames.slice(start).some(x => ['create', 'update', 'delete'].includes(x.action)), false);
}

for (const split of [false, true]) test(`Refresh rejects the last of eight resources without publishing earlier changes${split ? ', including split Read' : ''}`, { timeout: 15000 }, async t => {
  const { server, a, masterId, master } = await scenario(t, 8);
  const before = a.ulda.snapshot(), ids = master.data.contents.map(x => x.id);
  for (const entry of master.data.contents)
    server.records.set(entry.id, await successor(entry, server.records.get(entry.id), { value: 1 }));
  if (split) server.faults.push({ action: 'read', match: ids => ids.length === 8, error: 'too_large' });
  server.faults.push({ action: 'read', match: body => body.includes(ids.at(-1)),
    response: response => ({ ...response, data: response.data.map(record => record.id === ids.at(-1) ? damaged(record) : record) }) });
  const start = server.frames.length;
  await assert.rejects(a.ulda.refresh(), { code: 'CRYPTO_FAILED' });
  assert.deepEqual(a.ulda.snapshot(), before);
  assert.deepEqual(a.trace.filter(x => x.step === 'content.staged').flatMap(x => x.ids), ids.slice(0, -1));
  assert.deepEqual(a.trace.filter(x => x.step === 'snapshot.checked').flatMap(x => x.ids), ids.slice(0, -1));
  assert.equal(a.trace.some(x => x.step === 'chain.checked'), false);
  assert.equal(a.trace.some(x => x.step === 'refresh.memory'), false);
  assert.deepEqual(a.changes, []);
  assert.deepEqual(server.frames.slice(start).map(x => x.body), split
    ? [[masterId], ids, ids.slice(0, 4), ids.slice(4)] : [[masterId], ids]);
  noWritesSince(server, start);
  // A clean reread accepts the actual remote states; no corrupt result was cached.
  await a.ulda.refresh();
  for (let i = 0; i < 8; i++) assert.equal(a.ulda.value(`item-${i}`).value, 1);
});

test('Changed validates every updated resource before publishing a valid first and damaged last item', { timeout: 10000 }, async t => {
  const { server, a, master } = await scenario(t);
  const before = a.ulda.snapshot(), records = [];
  for (const entry of master.data.contents)
    records.push(await successor(entry, server.records.get(entry.id), { value: 1 }));
  const start = server.frames.length, fault = new Promise(resolve => a.ulda.on('error', resolve));
  server.sendChanged({ updated: [records[0], damaged(records[1])], deleted: [] });
  assert.equal((await fault).code, 'CRYPTO_FAILED');
  assert.equal(a.ulda.status, 'needsResync');
  assert.deepEqual(a.ulda.snapshot(), before);
  assert.deepEqual(a.changes, []);
  assert.ok(a.trace.some(x => x.step === 'content.opened' && x.ids[0] === records[0].id));
  assert.ok(a.trace.some(x => x.step === 'chain.checked' && x.ids[0] === records[0].id));
  assert.equal(a.trace.some(x => x.step === 'snapshot.checked'), false);
  assert.equal(a.trace.some(x => x.step === 'changed.memory'), false);
  noWritesSince(server, start);
});

test('A valid Changed master is not installed when its newly linked content fails Read validation', { timeout: 10000 }, async t => {
  const { server, a, masterId, master, credentials } = await scenario(t, 1);
  const before = a.ulda.snapshot();
  const entry = { id: '9000', name: 'remote-new', key: newContentSecret(), token: newToken() };
  const contentKeys = await contentCredentials(entry.key);
  const content = { id: entry.id, ...sealedWire(await seal(contentKeys, entry.token, newOrigin('X'), { value: 9 })) };
  const nextMaster = { id: masterId, ...sealedWire(await seal(credentials, master.token, advance(master.origin),
    { contents: [...master.data.contents, entry] })) };
  server.records.set(entry.id, content);
  server.records.set(masterId, nextMaster);
  server.faults.push({ action: 'read', match: body => body.includes(entry.id),
    response: () => ({ ok: true, data: [damaged(content)] }) });
  const start = server.frames.length, fault = new Promise(resolve => a.ulda.on('error', resolve));
  server.sendChanged({ updated: [nextMaster], deleted: [] });
  assert.equal((await fault).code, 'CRYPTO_FAILED');
  assert.deepEqual(a.ulda.snapshot(), before);
  assert.throws(() => a.ulda.ref(entry.name), { code: 'NOT_FOUND' });
  assert.deepEqual(a.changes, []);
  assert.ok(a.trace.some(x => x.step === 'master.opened'));
  assert.equal(a.trace.some(x => x.step === 'changed.memory'), false);
  assert.deepEqual(server.frames.slice(start).map(x => x.body), [[entry.id]]);
  noWritesSince(server, start);
  await a.ulda.refresh();
  assert.equal(a.ulda.value(entry.name).value, 9);
});

test('First Connect does not expose a verified master or first content when the last content is damaged', { timeout: 10000 }, async t => {
  const { server, client, masterId, password, master } = await scenario(t);
  const b = client();
  await b.ulda.ready;
  const lastId = master.data.contents.at(-1).id;
  server.faults.push({ action: 'read', match: body => body.includes(lastId),
    response: response => ({ ...response, data: response.data.map(record => record.id === lastId ? damaged(record) : record) }) });
  const start = server.frames.length;
  await assert.rejects(b.ulda.connect(masterId, password), { code: 'CRYPTO_FAILED' });
  assert.throws(() => b.ulda.snapshot(), { code: 'NOT_OPEN' });
  assert.ok(b.trace.some(x => x.step === 'content.staged' && x.ids[0] === master.data.contents[0].id));
  assert.equal(b.trace.some(x => x.step === 'session.memory'), false);
  assert.deepEqual(b.changes, []);
  noWritesSince(server, start);
});

test('SuperDelete never sends Delete or closes the context when the last preflight content is damaged', { timeout: 10000 }, async t => {
  const { server, a, master } = await scenario(t);
  const before = a.ulda.snapshot(), records = structuredClone(server.records), lastId = master.data.contents.at(-1).id;
  server.faults.push({ action: 'read', match: body => body.includes(lastId),
    response: response => ({ ...response, data: response.data.map(record => record.id === lastId ? damaged(record) : record) }) });
  const start = server.frames.length;
  await assert.rejects(a.ulda.superDelete(), { code: 'CRYPTO_FAILED' });
  assert.deepEqual(a.ulda.snapshot(), before);
  assert.notEqual(a.ulda.status, 'closed');
  assert.deepEqual(server.records, records);
  assert.equal(a.trace.some(x => ['superdelete.commit', 'session.clear'].includes(x.step)), false);
  noWritesSince(server, start);
});

test('A damaged Changed for pending Add stays private and cannot replace the local candidate on late ACK', { timeout: 10000 }, async t => {
  const { server, a, masterId, password } = await scenario(t, 0);
  let release;
  const held = new Promise(resolve => server.faults.push({ action: 'update', holdAck: send => { release = send; resolve(); } }));
  t.after(() => release?.());
  const result = a.ulda.add('pending', { value: 1 }).then(value => ({ value }), error => ({ error }));
  await held;
  const root = server.records.get(masterId);
  const credentials = await masterCredentials(password, envelope(root.payload).salt);
  const master = await open(credentials, root), entry = master.data.contents[0];
  const foreign = await successor(entry, server.records.get(entry.id), { value: 999 });
  const start = server.frames.length, fault = new Promise(resolve => a.ulda.on('error', resolve));
  server.sendChanged({ updated: [damaged(foreign)], deleted: [] });
  assert.equal((await fault).code, 'CRYPTO_FAILED');
  assert.equal(Object.hasOwn(a.ulda.snapshot(), 'pending'), false);
  assert.equal(a.trace.some(x => x.step === 'changed.memory'), false);
  assert.deepEqual(a.changes, []);
  noWritesSince(server, start);
  release();
  const settled = await result;
  assert.equal(settled.error, undefined);
  assert.equal(settled.value.ok, true);
  assert.equal(a.ulda.value('pending').value, 1);
  assert.equal(a.ulda.status, 'needsResync');
  assert.deepEqual(a.changes, []);
  noWritesSince(server, start);
});

for (const deletedKind of ['master', 'content']) test(`A mixed Changed with damaged content cannot apply its ${deletedKind} deletion`, { timeout: 10000 }, async t => {
  const { server, a, master, masterId } = await scenario(t, 3);
  const before = a.ulda.snapshot();
  const first = master.data.contents[0], last = master.data.contents[2];
  const valid = await successor(first, server.records.get(first.id), { value: 1 });
  const invalid = damaged(await successor(last, server.records.get(last.id), { value: 1 }));
  const deletedId = deletedKind === 'master' ? masterId : master.data.contents[1].id;
  // Observe both outcomes so the regression fails promptly if a premature close
  // bypasses verification instead of waiting for an error that never arrives.
  const outcome = new Promise(resolve => {
    a.ulda.on('error', error => resolve({ error }));
    a.ulda.on('trace', event => { if (event.step === 'session.clear') resolve({ closed: true }); });
  });
  const start = server.frames.length;
  server.sendChanged({ updated: [valid, invalid], deleted: [deletedId] });
  assert.equal((await outcome).error?.code, 'CRYPTO_FAILED');
  assert.equal(a.ulda.status, 'needsResync');
  assert.deepEqual(a.ulda.snapshot(), before);
  assert.deepEqual(a.changes, []);
  assert.equal(a.trace.some(x => ['changed.memory', 'session.clear'].includes(x.step)), false);
  noWritesSince(server, start);
});
