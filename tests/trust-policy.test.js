import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda } from '../src/index.js';
import { advance, newOrigin, sign } from '../src/core.js';
import { masterCredentials, newToken, envelope, open, seal, sealedWire } from '../src/crypto.js';
import { fixture } from './server.js';

async function scenario(t) {
  const server = await fixture(), clients = [];
  const client = () => {
    const sdk = new Ulda(server.url, { allowInsecureLocalhost: true, timeout: 3000 });
    const trace = [], errors = [], statuses = [];
    sdk.on('trace', value => trace.push(value));
    sdk.on('error', error => errors.push(error.code));
    sdk.on('status', status => statuses.push(status));
    clients.push(sdk);
    return { sdk, trace, errors, statuses };
  };
  t.after(async () => {
    for (const sdk of clients) await sdk.close();
    await server.close();
  });
  const a = client(), password = 'synthetic-trust-policy-password';
  const masterId = await a.sdk.register(password);
  return { server, a, client, password, masterId };
}

function noWritesSince(server, start) {
  assert.equal(server.frames.slice(start).some(frame => ['create', 'update', 'delete'].includes(frame.action)), false);
}

for (const mode of ['X', 'S']) test(`Refresh accepts authenticated ${mode} content after multiple missed edits from another device`, { timeout: 10000 }, async t => {
  const { server, a, client, masterId, password } = await scenario(t);
  await a.sdk.add('item', { value: 0 }, mode);
  const b = client(); await b.sdk.connect(masterId, password);
  for (let value = 1; value <= 6; value++) {
    server.faults.push({ action: 'update', dropChanged: true });
    await b.sdk.update('item', { value });
  }
  assert.equal(a.sdk.value('item').value, 0);
  const start = server.frames.length;
  a.trace.length = 0;
  await a.sdk.refresh();
  assert.equal(a.sdk.value('item').value, 6);
  assert.equal(a.sdk.status, 'open');
  assert.ok(a.trace.some(event => event.step === 'snapshot.checked'));
  assert.equal(a.trace.some(event => event.step === 'chain.checked'), false);
  noWritesSince(server, start);
});

test('Reconnect accepts a newer authenticated master and reads its new catalog after offline work on another device', { timeout: 10000 }, async t => {
  const { server, a, client, masterId, password } = await scenario(t);
  await a.sdk.add('existing', { value: 0 });
  const b = client(); await b.sdk.connect(masterId, password);
  const disconnected = new Promise(resolve => a.sdk.on('status', status => {
    if (status === 'disconnected') resolve();
  }));
  const aSocket = server.frames.find(frame => frame.action === 'create').socket;
  server.io.sockets.sockets.get(aSocket).disconnect(true);
  await disconnected;
  for (let i = 0; i < 4; i++) await b.sdk.add(`remote-${i}`, { value: i });
  assert.deepEqual(Object.keys(a.sdk.snapshot()), ['existing']);
  const start = server.frames.length;
  a.trace.length = 0;
  await a.sdk.reconnect();
  assert.equal(a.sdk.status, 'open');
  assert.equal(Object.keys(a.sdk.snapshot()).length, 5);
  assert.equal(a.sdk.value('remote-3').value, 3);
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
  const fault = new Promise(resolve => a.sdk.on('error', resolve));
  server.sendChanged({ updated: [next], deleted: [] });
  assert.equal((await fault).code, 'NEEDS_RESYNC');
  assert.equal(a.sdk.status, 'needsResync');
  const start = server.frames.length;
  await a.sdk.refresh();
  assert.equal(a.sdk.status, 'open');
  noWritesSince(server, start);
});

test('Snapshot trust never bypasses token, mode, ciphertext, origin/witness or same-age checks; failures block writes', { timeout: 15000 }, async t => {
  const { server, a, masterId, password } = await scenario(t);
  await a.sdk.add('kept', { value: 1 });
  const record = server.records.get(masterId), before = a.sdk.snapshot();
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
    await assert.rejects(a.sdk.refresh(), { code: variant.code });
    assert.deepEqual(a.sdk.snapshot(), before);
    assert.equal(a.sdk.status, 'needsResync');
    assert.equal(a.statuses.at(-1), 'needsResync');
    assert.throws(() => a.sdk.update('kept', { value: 2 }), { code: 'NEEDS_RESYNC' });
    noWritesSince(server, start);
    await a.sdk.refresh();
    assert.equal(a.sdk.status, 'open');
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
  await a.sdk.refresh();
  assert.equal(a.sdk.status, 'open');
  assert.equal(Object.keys(a.sdk.snapshot()).length, 0);
  noWritesSince(server, start);
  // Reaching the supported age ceiling does not wrap the chain on the next write.
  await assert.rejects(a.sdk.add('beyond-ceiling', {}), { code: 'LIMIT' });
});

test('Trusted content deletion removes its working copy; missing Read retains other verified data and blocks writes', { timeout: 10000 }, async t => {
  const { server, a, masterId } = await scenario(t);
  await a.sdk.add('removed', { value: 1 });
  await a.sdk.add('kept', { value: 2 });
  const id = [...server.records.keys()].find(id => id !== masterId);
  const deleted = new Promise(resolve => a.sdk.on('change', event => { if (event.kind === 'deleted') resolve(event); }));
  const start = server.frames.length;
  server.records.delete(id);
  server.sendChanged({ updated: [], deleted: [id] });
  assert.deepEqual((await deleted).ids, [id]);
  assert.equal(Object.hasOwn(a.sdk.snapshot(), 'removed'), false);
  assert.equal(a.sdk.value('kept').value, 2);
  await assert.rejects(a.sdk.refresh(), { code: 'NOT_FOUND' });
  assert.equal(a.sdk.status, 'needsResync');
  assert.equal(a.sdk.value('kept').value, 2);
  assert.throws(() => a.sdk.update('kept', { value: 3 }), { code: 'NEEDS_RESYNC' });
  noWritesSince(server, start);
});

test('Trusted master deletion closes context and invalidates old references without sending data writes', { timeout: 10000 }, async t => {
  const { server, a, masterId } = await scenario(t);
  await a.sdk.add('item', { value: 1 });
  const reference = a.sdk.ref('item');
  const closed = new Promise(resolve => a.sdk.on('status', status => { if (status === 'closed') resolve(); }));
  const start = server.frames.length;
  server.sendChanged({ updated: [], deleted: [masterId] });
  await closed;
  assert.equal(a.sdk.status, 'closed');
  assert.throws(() => a.sdk.snapshot(), { code: 'CLOSED' });
  assert.throws(() => reference.get(), { code: 'STALE_REFERENCE' });
  noWritesSince(server, start);
});

test('Closing from the refresh status callback cannot return a revived context', { timeout: 10000 }, async t => {
  const { server, a } = await scenario(t);
  a.sdk.on('status', status => { if (status === 'open') void a.sdk.close(); });
  const start = server.frames.length;
  await assert.rejects(a.sdk.refresh(), { code: 'CLOSED' });
  await a.sdk.close();
  assert.equal(a.sdk.status, 'closed');
  assert.throws(() => a.sdk.snapshot(), { code: 'CLOSED' });
  noWritesSince(server, start);
});
