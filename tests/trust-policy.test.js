import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda } from '../src/index.js';
import { advance, newOrigin, sign } from '../src/core.js';
import { masterCredentials, newToken, envelope, open, seal, sealedWire } from '../src/crypto.js';
import { fixture } from './server.js';

async function scenario(t) {
  const server = await fixture(), clients = [];
  const client = () => {
    const ulda = new Ulda(server.url, { allowInsecureLocalhost: true, timeout: 3000 });
    const trace = [], errors = [], statuses = [];
    ulda.on('trace', value => trace.push(value));
    ulda.on('error', error => errors.push(error.code));
    ulda.on('status', status => statuses.push(status));
    clients.push(ulda);
    return { ulda, trace, errors, statuses };
  };
  t.after(async () => {
    for (const ulda of clients) await ulda.close();
    await server.close();
  });
  const a = client(), password = 'synthetic-trust-policy-password';
  const masterId = await a.ulda.register(password);
  return { server, a, client, password, masterId };
}

function noWritesSince(server, start) {
  assert.equal(server.frames.slice(start).some(frame => ['create', 'update', 'delete'].includes(frame.action)), false);
}

for (const mode of ['X', 'S']) test(`Refresh accepts authenticated ${mode} content after multiple missed edits from another device`, { timeout: 10000 }, async t => {
  const { server, a, client, masterId, password } = await scenario(t);
  await a.ulda.add('item', { value: 0 }, mode);
  const b = client(); await b.ulda.connect(masterId, password);
  for (let value = 1; value <= 6; value++) {
    server.faults.push({ action: 'update', dropChanged: true });
    await b.ulda.update('item', { value });
  }
  assert.equal(a.ulda.value('item').value, 0);
  const start = server.frames.length;
  a.trace.length = 0;
  await a.ulda.refresh();
  assert.equal(a.ulda.value('item').value, 6);
  assert.equal(a.ulda.status, 'open');
  assert.ok(a.trace.some(event => event.step === 'snapshot.checked'));
  assert.equal(a.trace.some(event => event.step === 'chain.checked'), false);
  noWritesSince(server, start);
});

test('Reconnect accepts a newer authenticated master and reads its new catalog after offline work on another device', { timeout: 10000 }, async t => {
  const { server, a, client, masterId, password } = await scenario(t);
  await a.ulda.add('existing', { value: 0 });
  const b = client(); await b.ulda.connect(masterId, password);
  const disconnected = new Promise(resolve => a.ulda.on('status', status => {
    if (status === 'disconnected') resolve();
  }));
  const aSocket = server.frames.find(frame => frame.action === 'create').socket;
  server.io.sockets.sockets.get(aSocket).disconnect(true);
  await disconnected;
  for (let i = 0; i < 4; i++) await b.ulda.add(`remote-${i}`, { value: i });
  assert.deepEqual(Object.keys(a.ulda.snapshot()), ['existing']);
  const start = server.frames.length;
  a.trace.length = 0;
  await a.ulda.reconnect();
  assert.equal(a.ulda.status, 'open');
  assert.equal(Object.keys(a.ulda.snapshot()).length, 5);
  assert.equal(a.ulda.value('remote-3').value, 3);
  assert.ok(a.trace.some(event => event.step === 'snapshot.checked' && event.ids[0] === masterId));
  noWritesSince(server, start);
  const readerSocket = server.frames.slice(start).find(frame => frame.action === 'read').socket;
  assert.ok([...server.watchers.get(masterId)].some(socket => socket.id === readerSocket));
});

test('A realtime X gap requests resync, then explicit Read accepts the authenticated server snapshot', { timeout: 10000 }, async t => {
  const { server, a, masterId, password } = await scenario(t);
  const record = server.records.get(masterId);
  const credentials = await masterCredentials(password, envelope(record.payload).salt);
  const state = await open(credentials, record);
  const next = { id: masterId, ...sealedWire(await seal(credentials, state.token, advance(advance(state.origin)), state.data)) };
  // Synthetic holder of the key simulates a valid remote snapshot; this is not
  // an assertion that the server can manufacture authenticated ciphertext.
  server.records.set(masterId, next);
  const fault = new Promise(resolve => a.ulda.on('error', resolve));
  server.sendChanged({ updated: [next], deleted: [] });
  assert.equal((await fault).code, 'NEEDS_RESYNC');
  assert.equal(a.ulda.status, 'needsResync');
  const start = server.frames.length;
  await a.ulda.refresh();
  assert.equal(a.ulda.status, 'open');
  noWritesSince(server, start);
});

test('Snapshot trust never bypasses token, mode, ciphertext, origin/witness or same-age checks; failures block writes', { timeout: 15000 }, async t => {
  const { server, a, masterId, password } = await scenario(t);
  await a.ulda.add('kept', { value: 1 });
  const record = server.records.get(masterId), before = a.ulda.snapshot();
  const credentials = await masterCredentials(password, envelope(record.payload).salt);
  const state = await open(credentials, record);
  const futureOrigin = advance(advance(state.origin));
  const wrapped = async (token, origin) => ({ id: masterId, ...sealedWire(await seal(credentials, token, origin, state.data)) });
  const invalidCiphertext = await wrapped(state.token, futureOrigin);
  invalidCiphertext.payload[invalidCiphertext.payload.length - 1] ^= 1;
  const inconsistent = await wrapped(state.token, futureOrigin);
  // Replacing just the public witness also changes AAD and cannot be accepted.
  inconsistent.witness = await sign(advance(futureOrigin));
  const variants = [
    { record: await wrapped(newToken(), futureOrigin), code: 'CRYPTO_FAILED' },
    { record: await wrapped(state.token, advance(advance(newOrigin('S')))), code: 'CRYPTO_FAILED' },
    { record: invalidCiphertext, code: 'CRYPTO_FAILED' },
    { record: inconsistent, code: 'CRYPTO_FAILED' },
    { record: await wrapped(state.token, state.origin), code: 'ROLLBACK' },
    { record: await wrapped(state.token, newOrigin('X')), code: 'ROLLBACK' },
  ];
  for (const variant of variants) {
    const start = server.frames.length;
    server.faults.push({ action: 'read', match: body => body.includes(masterId),
      response: () => ({ ok: true, data: [variant.record] }) });
    await assert.rejects(a.ulda.refresh(), { code: variant.code });
    assert.deepEqual(a.ulda.snapshot(), before);
    assert.equal(a.ulda.status, 'needsResync');
    assert.equal(a.statuses.at(-1), 'needsResync');
    assert.throws(() => a.ulda.update('kept', { value: 2 }), { code: 'NEEDS_RESYNC' });
    noWritesSince(server, start);
    await a.ulda.refresh();
    assert.equal(a.ulda.status, 'open');
  }
});

test('A huge authenticated age is accepted as a snapshot without deriving intermediate origins', { timeout: 10000 }, async t => {
  const { server, a, masterId, password } = await scenario(t);
  const record = server.records.get(masterId);
  const credentials = await masterCredentials(password, envelope(record.payload).salt);
  const state = await open(credentials, record);
  // Constructing an extreme-age package requires the test's known key. No loop
  // over the claimed age should be introduced by the snapshot policy.
  const UldaSign = (await import('ulda-core')).default;
  const core = new UldaSign({ fmt: { export: 'bytes' }, sign: { mode: 'X', N: 5, hash: 'SHA-256', originSize: 256, pack: 'compactV1' } });
  const parsed = core.actions.import.signature(state.origin);
  const origin = core.codec.encodeWitness(parsed.body, { index: 0xffffffffn, mode: 'X', N: 5, hash: 'SHA-256' });
  server.records.set(masterId, { id: masterId, ...sealedWire(await seal(credentials, state.token, origin, state.data)) });
  const start = server.frames.length;
  await a.ulda.refresh();
  assert.equal(a.ulda.status, 'open');
  assert.equal(Object.keys(a.ulda.snapshot()).length, 0);
  noWritesSince(server, start);
  // Reaching the supported age ceiling does not wrap the chain on the next write.
  await assert.rejects(a.ulda.add('beyond-ceiling', {}), { code: 'LIMIT' });
});

test('Trusted content deletion removes its working copy; missing Read retains other verified data and blocks writes', { timeout: 10000 }, async t => {
  const { server, a, masterId } = await scenario(t);
  await a.ulda.add('removed', { value: 1 });
  await a.ulda.add('kept', { value: 2 });
  const id = [...server.records.keys()].find(id => id !== masterId);
  const deleted = new Promise(resolve => a.ulda.on('change', event => { if (event.kind === 'deleted') resolve(event); }));
  const start = server.frames.length;
  server.records.delete(id);
  server.sendChanged({ updated: [], deleted: [id] });
  assert.deepEqual((await deleted).ids, [id]);
  assert.equal(Object.hasOwn(a.ulda.snapshot(), 'removed'), false);
  assert.equal(a.ulda.value('kept').value, 2);
  await assert.rejects(a.ulda.refresh(), { code: 'NOT_FOUND' });
  assert.equal(a.ulda.status, 'needsResync');
  assert.equal(a.ulda.value('kept').value, 2);
  assert.throws(() => a.ulda.update('kept', { value: 3 }), { code: 'NEEDS_RESYNC' });
  noWritesSince(server, start);
});

test('Trusted master deletion closes context and invalidates old references without sending data writes', { timeout: 10000 }, async t => {
  const { server, a, masterId } = await scenario(t);
  await a.ulda.add('item', { value: 1 });
  const reference = a.ulda.ref('item');
  const closed = new Promise(resolve => a.ulda.on('status', status => { if (status === 'closed') resolve(); }));
  const start = server.frames.length;
  server.sendChanged({ updated: [], deleted: [masterId] });
  await closed;
  assert.equal(a.ulda.status, 'closed');
  assert.throws(() => a.ulda.snapshot(), { code: 'CLOSED' });
  assert.throws(() => reference.get(), { code: 'STALE_REFERENCE' });
  noWritesSince(server, start);
});

test('Closing from the refresh status callback cannot return a revived context', { timeout: 10000 }, async t => {
  const { server, a } = await scenario(t);
  a.ulda.on('status', status => { if (status === 'open') void a.ulda.close(); });
  const start = server.frames.length;
  await assert.rejects(a.ulda.refresh(), { code: 'CLOSED' });
  await a.ulda.close();
  assert.equal(a.ulda.status, 'closed');
  assert.throws(() => a.ulda.snapshot(), { code: 'CLOSED' });
  noWritesSince(server, start);
});
