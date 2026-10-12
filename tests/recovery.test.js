import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { masterCredentials, envelope, open } from '../src/crypto.js';
import { inspect } from '../src/core.js';
import { fixture } from './server.js';

const password = 'synthetic-explicit-recovery-password';
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected recovery state was not reached');
}
async function setup(t, mode = 'X') {
  const server = await fixture(), clients = [];
  const client = () => {
    const transport = new SocketIoTransport(server.url, { timeout: 700, allowInsecureLocalhost: true });
    const ulda = new Ulda(server.url, { transport, reconnect: false }), trace = [];
    transport.on('trace', event => trace.push(event));
    ulda.on('trace', event => trace.push(event));
    clients.push(ulda); return { ulda, transport, trace };
  };
  t.after(async () => { for (const ulda of clients) await ulda.close(); await server.close(); });
  const a = client(), masterId = await a.ulda.register(password);
  await a.ulda.add('note-private-name', { text: 'synthetic-private-content', n: 1 }, mode);
  await a.ulda.add('other', { keep: true });
  async function catalog() {
    const record = server.records.get(masterId);
    return open(await masterCredentials(password, envelope(record.payload).salt), record);
  }
  const root = await catalog(), entry = root.data.contents.find(x => x.name === 'note-private-name');
  return { server, client, a, masterId, entry, catalog };
}
function hold(server, action) {
  let release;
  const held = new Promise(resolve => server.faults.push({ action, holdAck: send => { release = send; resolve(); } }));
  return { held, release: () => release?.() };
}
const writes = frames => frames.filter(frame => ['create', 'update', 'delete'].includes(frame.action));
const damage = record => { const payload = record.payload.slice(); payload[payload.length - 1] ^= 1; return { ...record, payload }; };

for (const mode of ['X', 'S']) test(`Explicit ${mode} recovery replaces one catalog entry, keeps old resource, and updates a second client`, async t => {
  const { server, a, client, masterId, entry, catalog } = await setup(t, mode), b = client();
  await b.ulda.connect(masterId, password);
  const ref = a.ulda.ref(entry.name), peerRef = b.ulda.ref(entry.name);
  const old = structuredClone(server.records.get(entry.id)), before = JSON.stringify(a.ulda.snapshot());
  const offset = server.frames.length;
  const result = await a.ulda.recoverContent(entry.name);
  assert.equal(result.ok, true); assert.equal(result.previousId, entry.id);
  assert.notEqual(result.id, entry.id); assert.equal(result.sourceAge, 1); assert.equal(result.reconciled, false);
  assert.equal(a.ulda.status, 'open'); assert.equal(JSON.stringify(a.ulda.snapshot()), before);
  assert.deepEqual(server.records.get(entry.id), old);
  const root = await catalog(), replacement = root.data.contents.find(x => x.name === entry.name);
  assert.equal(replacement.id, result.id); assert.notEqual(replacement.key, entry.key); assert.notEqual(replacement.token, entry.token);
  assert.equal(inspect(server.records.get(result.id).witness).mode, mode);
  const frames = writes(server.frames.slice(offset));
  assert.deepEqual(frames.map(frame => frame.action), ['create', 'update']);
  assert.deepEqual(frames[1].body.map(item => item.id), [result.id, masterId]);
  assert.equal(server.frames.slice(offset).some(frame => frame.action === 'delete'), false);
  assert.throws(() => ref.get(), { code: 'STALE_REFERENCE' });
  await until(() => b.trace.some(event => event.step === 'changed.memory' && event.ids.includes(result.id)));
  assert.throws(() => peerRef.get(), { code: 'STALE_REFERENCE' });
  await b.ulda.update(entry.name, { from: 'peer' });
  await until(() => a.ulda.value(entry.name).from === 'peer');
  const serialized = JSON.stringify(a.trace);
  for (const secret of [password, entry.name, entry.key, replacement.key, entry.token, replacement.token, 'synthetic-private-content'])
    assert.equal(serialized.includes(secret), false);
});

test('A damaged server content is replaced from the last verified copy without reading or deleting the damaged target', async t => {
  const { server, a, entry } = await setup(t);
  const bad = damage(server.records.get(entry.id)); server.records.set(entry.id, bad);
  await assert.rejects(a.ulda.refresh(), { code: 'CRYPTO_FAILED' });
  assert.equal(a.ulda.value(entry.name).n, 1);
  const offset = server.frames.length;
  const result = await a.ulda.recoverContent(entry.name);
  assert.equal(a.ulda.value(entry.name).n, 1); assert.equal(a.ulda.status, 'open');
  assert.notEqual(result.id, entry.id); assert.deepEqual(server.records.get(entry.id), bad);
  assert.equal(server.frames.slice(offset).some(frame => frame.action === 'read' && frame.body.includes(entry.id)), false);
});

test('A corrupt master or another corrupt content stops recovery before Create, preserving the checked copy', async t => {
  const { server, a, masterId, entry, catalog } = await setup(t);
  const other = (await catalog()).data.contents.find(x => x.name === 'other').id;
  for (const id of [masterId, other]) {
    const original = server.records.get(id), offset = server.frames.length;
    server.records.set(id, damage(original));
    await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CRYPTO_FAILED' });
    assert.equal(a.ulda.value(entry.name).n, 1); assert.equal(writes(server.frames.slice(offset)).length, 0);
    server.records.set(id, original);
  }
  assert.equal((await a.ulda.recoverContent(entry.name)).ok, true);
});

test('No verified copy after a trusted deletion means no recovery write and no hidden backup', async t => {
  const { server, a, entry } = await setup(t);
  server.records.delete(entry.id); server.sendChanged({ updated: [], deleted: [entry.id] });
  await until(() => !Object.hasOwn(a.ulda.snapshot(), entry.name));
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'NOT_FOUND' });
  assert.equal(server.frames.length, offset);
  const unopened = new Ulda(server.url, { allowInsecureLocalhost: true, reconnect: false });
  t.after(() => unopened.close()); await unopened.ready;
  await assert.rejects(unopened.recoverContent(entry.name), { code: 'NOT_OPEN' });
});

test('An unresolved ordinary write cannot become a recovery source', async t => {
  const { server, a, entry } = await setup(t);
  server.faults.push({ action: 'update', dropRequest: true });
  await assert.rejects(a.ulda.update(entry.name, { unconfirmed: true }), { code: 'UNKNOWN_OUTCOME' });
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'NEEDS_RESYNC' });
  assert.equal(server.frames.length, offset); assert.equal(a.ulda.value(entry.name).n, 1);
});

test('A definitive Create failure permits an explicit retry; it never retries by itself', async t => {
  const { server, a, entry } = await setup(t), size = server.records.size;
  server.faults.push({ action: 'create', error: 'storage_error' });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'SERVER_ERROR' });
  assert.equal(server.records.size, size);
  const result = await a.ulda.recoverContent(entry.name);
  assert.equal(result.reconciled, false); assert.equal(server.records.size, size + 1);
});

for (const fault of ['dropRequest', 'dropAck', 'invalidAck']) test(`Recovery Create ${fault}: unknown ID cannot silently allocate another resource`, async t => {
  const { server, a, entry } = await setup(t), size = server.records.size;
  server.faults.push({ action: 'create', ...(fault === 'invalidAck' ? { response: () => ({ ok: true, data: ['bad'] }) } : { [fault]: true }) });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  assert.equal(server.frames.length, offset);
  assert.equal(server.records.size, size + (fault === 'dropRequest' ? 0 : 1));
  assert.equal(a.ulda.value(entry.name).n, 1);
  assert.throws(() => a.ulda.update(entry.name, {}), { code: 'NEEDS_RESYNC' });
});

test('A definitive atomic Update conflict reuses the same reserved ID on explicit retry', async t => {
  const { server, a, entry, masterId } = await setup(t), size = server.records.size;
  const before = structuredClone(server.records.get(masterId));
  const offset = server.frames.length;
  server.faults.push({ action: 'update', error: 'conflict' });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CONFLICT' });
  assert.deepEqual(server.records.get(masterId), before); assert.equal(server.records.size, size + 1);
  const reservedId = [...server.records.keys()].at(-1);
  const result = await a.ulda.recoverContent(entry.name);
  assert.equal(result.id, reservedId); assert.equal(server.records.size, size + 1);
  assert.equal(server.frames.slice(offset).filter(frame => frame.action === 'create').length, 1);
  assert.equal(a.ulda.status, 'open');
});

test('Lost Update ACK is resolved by verified reads, preserving a later peer edit without replay', async t => {
  const { server, a, client, entry, masterId } = await setup(t), b = client();
  await b.ulda.connect(masterId, password);
  server.faults.push({ action: 'update', dropAck: true });
  const original = a.ulda.recoverContent(entry.name).then(() => assert.fail('Lost ACK must reject'), error => error.code);
  await until(() => b.trace.some(event => event.step === 'changed.memory'));
  await b.ulda.update(entry.name, { afterRecovery: 2 });
  assert.equal(await original, 'UNKNOWN_OUTCOME');
  const offset = server.frames.length;
  const result = await a.ulda.recoverContent(entry.name);
  assert.equal(result.reconciled, true); assert.equal(a.ulda.value(entry.name).afterRecovery, 2);
  assert.equal(writes(server.frames.slice(offset)).length, 0); assert.equal(a.ulda.status, 'open');
});

test('An old read after dropped recovery Update cannot authorize a retry of an unknown write', async t => {
  const { server, a, entry } = await setup(t);
  server.faults.push({ action: 'update', dropRequest: true });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  const offset = server.frames.length;
  for (let i = 0; i < 2; i++) await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  assert.equal(writes(server.frames.slice(offset)).length, 0);
  assert.equal(a.ulda.value(entry.name).n, 1); assert.equal(a.ulda.status, 'needsResync');
});

test('A reservation changed outside the operation is never overwritten by an explicit retry', async t => {
  const { server, a, entry } = await setup(t);
  server.faults.push({ action: 'update', error: 'conflict' });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CONFLICT' });
  const id = [...server.records.keys()].at(-1); server.records.set(id, damage(server.records.get(id)));
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CONFLICT' });
  assert.equal(writes(server.frames.slice(offset)).length, 0); assert.equal(a.ulda.value(entry.name).n, 1);
});

test('A foreign catalog update during Create causes conflict; explicit retry preserves it using the same ID', async t => {
  const { server, a, client, entry, masterId } = await setup(t), b = client();
  await b.ulda.connect(masterId, password);
  const gate = hold(server, 'create'); t.after(gate.release);
  const offset = server.frames.length;
  const recovery = a.ulda.recoverContent(entry.name).then(() => assert.fail('Expected conflict'), error => error.code);
  await gate.held; const reserved = [...server.records.keys()].at(-1);
  await b.ulda.add('concurrent', { keep: 42 }); gate.release();
  assert.equal(await recovery, 'CONFLICT');
  const result = await a.ulda.recoverContent(entry.name);
  assert.equal(result.id, reserved); assert.equal(a.ulda.value('concurrent').keep, 42);
  // One reservation for recovery, one resource for the peer Add.
  assert.equal(server.frames.slice(offset).filter(frame => frame.action === 'create').length, 2);
});

test('A peer update before delayed recovery ACK is applied after publication, never rolled back', async t => {
  const { server, a, client, entry, masterId } = await setup(t), b = client();
  await b.ulda.connect(masterId, password);
  const gate = hold(server, 'update'); t.after(gate.release);
  const recovery = a.ulda.recoverContent(entry.name); await gate.held;
  await until(() => b.trace.some(event => event.step === 'changed.memory'));
  await b.ulda.update(entry.name, { newer: true });
  await until(() => a.trace.some(event => event.phase === 'push'));
  gate.release(); await recovery;
  await until(() => a.ulda.value(entry.name).newer === true);
  assert.equal(a.ulda.status, 'open');
});

for (const action of ['create', 'update']) test(`Close during recovery ${action} ACK cannot restore context or issue later writes`, async t => {
  const { server, a, entry } = await setup(t);
  const gate = hold(server, action); t.after(gate.release);
  const recovery = a.ulda.recoverContent(entry.name).then(() => assert.fail('Closed recovery unexpectedly succeeded'), error => error.code);
  await gate.held;
  const offset = server.frames.length;
  await a.ulda.close(); gate.release();
  assert.ok(['CLOSED', 'UNKNOWN_OUTCOME'].includes(await recovery));
  assert.equal(a.ulda.status, 'closed');
  assert.equal(writes(server.frames.slice(offset)).length, 0);
});

test('Recovery serializes local changes and close from preparation callback stops before Create', async t => {
  const { server, a, entry } = await setup(t);
  let close;
  const offset = server.frames.length;
  a.ulda.on('trace', event => { if (event.step === 'repair.checked') close = a.ulda.close(); });
  const result = a.ulda.recoverContent(entry.name);
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'BUSY' });
  await assert.rejects(result, { code: 'CLOSED' }); await close;
  assert.equal(writes(server.frames.slice(offset)).length, 0);
});

test('After a known failed update, missing reservation is an error, never a fresh Create', async t => {
  const { server, a, entry } = await setup(t);
  server.faults.push({ action: 'update', error: 'conflict' });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CONFLICT' });
  server.records.delete([...server.records.keys()].at(-1));
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'NOT_FOUND' });
  assert.equal(writes(server.frames.slice(offset)).length, 0);
});

test('A Create ACK colliding with a known ID is unknown outcome, never an Update of that ID', async t => {
  const { server, a, entry } = await setup(t);
  server.faults.push({ action: 'create', response: () => ({ ok: true, data: [entry.id] }) });
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  assert.deepEqual(writes(server.frames.slice(offset)).map(frame => frame.action), ['create']);
});

test('A reservation encryption failure remains explicitly retryable without exposing the runtime error', async t => {
  const { server, a, entry } = await setup(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), real = globalThis.crypto;
  const subtle = new Proxy(real.subtle, { get(target, key) {
    if (key === 'encrypt') return () => Promise.reject(new Error('synthetic-private-runtime-details'));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: array => real.getRandomValues(array) } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CRYPTO_FAILED' });
  assert.equal(writes(server.frames.slice(offset)).length, 0);
  Object.defineProperty(globalThis, 'crypto', descriptor);
  assert.equal((await a.ulda.recoverContent(entry.name)).ok, true);
});

test('A malformed resource at the end of unknown-outcome reconciliation cannot partially publish the new catalog', async t => {
  const { server, a, entry, catalog } = await setup(t);
  const other = (await catalog()).data.contents.find(x => x.name === 'other').id;
  server.faults.push({ action: 'update', dropAck: true });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  const before = JSON.stringify(a.ulda.snapshot()), original = server.records.get(other);
  server.records.set(other, damage(original));
  const offset = server.frames.length;
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'CRYPTO_FAILED' });
  assert.equal(JSON.stringify(a.ulda.snapshot()), before);
  assert.equal(writes(server.frames.slice(offset)).length, 0);
  server.records.set(other, original);
  assert.equal((await a.ulda.recoverContent(entry.name)).reconciled, true);
});

test('Reconnect reads a pending recovery without replay and leaves its resolution to the explicit method', async t => {
  const { server, a, entry } = await setup(t);
  server.faults.push({ action: 'update', dropAck: true });
  await assert.rejects(a.ulda.recoverContent(entry.name), { code: 'UNKNOWN_OUTCOME' });
  const offset = server.frames.length;
  a.transport.disconnect();
  await assert.rejects(a.ulda.reconnect(), { code: 'NEEDS_RESYNC' });
  assert.equal(a.ulda.status, 'needsResync');
  assert.equal((await a.ulda.recoverContent(entry.name)).reconciled, true);
  assert.equal(writes(server.frames.slice(offset)).length, 0); assert.equal(a.ulda.status, 'open');
});

test('Incoming queue overflow during recovery ACK cannot be cleared by local publication', async t => {
  const { server, a, entry } = await setup(t), old = server.records.get(entry.id);
  const gate = hold(server, 'update'); t.after(gate.release);
  const errors = [];
  a.ulda.on('error', error => errors.push(error.code));
  const recovery = a.ulda.recoverContent(entry.name); await gate.held;
  for (let i = 0; i < 10; i++) server.sendChanged({ updated: [old], deleted: [] });
  await until(() => errors.includes('LIMIT'));
  gate.release(); assert.equal((await recovery).ok, true);
  assert.equal(a.ulda.status, 'needsResync');
  assert.throws(() => a.ulda.update(entry.name, {}), { code: 'NEEDS_RESYNC' });
  await a.ulda.refresh(); assert.equal(a.ulda.status, 'open');
});
