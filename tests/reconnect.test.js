import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { fixture } from './server.js';

const fast = { maxAttempts: 3, initialDelay: 20, maxDelay: 40, jitter: 0, budget: 2000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < end, 'Condition did not become true before deadline');
    await sleep(5);
  }
}
async function scenario(t, reconnect = fast) {
  const server = await fixture(), events = [], statuses = [], errors = [];
  const transport = new SocketIoTransport(server.url, { allowInsecureLocalhost: true, timeout: 500 });
  const ulda = new Ulda(server.url, { transport, reconnect });
  ulda.on('reconnect', event => events.push(event));
  ulda.on('status', status => statuses.push(status));
  ulda.on('error', error => errors.push(error.code));
  t.after(async () => { await ulda.close(); await server.close(); });
  const masterId = await ulda.register('synthetic-reconnect-password');
  const socket = () => server.io.sockets.sockets.get(server.frames.findLast(x => x.action === 'hello').socket);
  const cut = () => socket().conn.close();
  return { ulda, server, transport, events, statuses, errors, masterId, cut };
}
function writes(server, start) {
  return server.frames.slice(start).filter(x => ['create', 'update', 'delete'].includes(x.action));
}

test('Automatic reconnect restores a newer snapshot and subscriptions once; manual callers join it', { timeout: 10000 }, async t => {
  const { ulda, server, events, masterId, cut } = await scenario(t, { ...fast, initialDelay: 250, maxDelay: 250 });
  await ulda.add('item', { value: 0 });
  const second = new Ulda(server.url, { allowInsecureLocalhost: true, reconnect: false });
  t.after(() => second.close());
  await second.connect(masterId, 'synthetic-reconnect-password');
  // The latest hello now belongs to the second client; cut the first by its Create.
  const old = server.frames.find(x => x.action === 'create').socket;
  server.io.sockets.sockets.get(old).conn.close();
  await until(() => events.some(x => x.phase === 'waiting'));
  const a = ulda.reconnect(), b = ulda.reconnect();
  assert.equal(a, b);
  assert.throws(() => ulda.update('item', { value: -1 }), { code: 'NEEDS_RESYNC' });
  for (let i = 1; i <= 6; i++) await second.update('item', { value: i });
  const start = server.frames.length;
  assert.equal(await a, ulda.data);
  assert.equal(ulda.value('item').value, 6);
  assert.equal(ulda.status, 'open');
  assert.equal(events.filter(x => x.phase === 'attempt').length, 1);
  assert.equal(server.frames.slice(start).filter(x => x.action === 'hello').length, 1);
  assert.equal(writes(server, start).length, 0);
  const now = server.frames.findLast(x => x.action === 'hello').socket;
  assert.notEqual(now, old);
  assert.equal([...server.subscriptions.keys()].some(socket => socket.id === old), false);
  assert.equal(server.subscriptions.get(server.io.sockets.sockets.get(now)).size, 2);
  await second.update('item', { value: 7 });
  await until(() => ulda.value('item').value === 7);
});

test('Unavailable server exhausts bounded attempts and permits a new manual cycle', { timeout: 10000 }, async t => {
  const { ulda, server, events, cut } = await scenario(t);
  let reject = true;
  server.io.use((socket, next) => next(reject ? new Error('test unavailable') : undefined));
  cut();
  await until(() => events.some(x => x.phase === 'stopped'));
  assert.equal(events.filter(x => x.phase === 'attempt').length, 3);
  assert.equal(ulda.status, 'disconnected');
  await sleep(100);
  assert.equal(events.filter(x => x.phase === 'attempt').length, 3);
  reject = false;
  await ulda.reconnect();
  assert.equal(ulda.status, 'open');
});

test('Initial failure is not retried; explicit recovery repairs ready for register', { timeout: 10000 }, async t => {
  const server = await fixture();
  let reject = true;
  server.io.use((socket, next) => next(reject ? new Error('test unavailable') : undefined));
  const ulda = new Ulda(server.url, { allowInsecureLocalhost: true, timeout: 100, reconnect: fast });
  const events = []; ulda.on('reconnect', event => events.push(event));
  t.after(async () => { await ulda.close(); await server.close(); });
  await assert.rejects(ulda.ready, { code: 'OFFLINE' });
  await sleep(100);
  assert.equal(events.length, 0);
  reject = false;
  await ulda.reconnect();
  assert.equal(typeof await ulda.register('synthetic-password'), 'string');
});

for (const phase of ['waiting', 'hello', 'read']) test(`Close during recovery ${phase} cancels work and late ACK cannot reopen SDK`, { timeout: 10000 }, async t => {
  const { ulda, server, events, cut } = await scenario(t);
  let deliver;
  if (phase !== 'waiting') server.faults.push({ action: phase, holdAck: fn => { deliver = fn; } });
  cut();
  await until(() => phase === 'waiting' ? events.some(x => x.phase === 'waiting') : !!deliver);
  const recovering = ulda.reconnect();
  const rejected = assert.rejects(recovering, { code: 'CLOSED' });
  await ulda.close(); await rejected;
  const start = server.frames.length, attempts = events.filter(x => x.phase === 'attempt').length;
  deliver?.(); await sleep(100);
  assert.equal(ulda.status, 'closed');
  assert.equal(events.filter(x => x.phase === 'attempt').length, attempts);
  assert.equal(server.frames.slice(start).some(x => x.action === 'hello' || x.action === 'read'), false);
});

test('Whole-cycle deadline bounds a pending hello; late success cannot restore it', { timeout: 10000 }, async t => {
  const { ulda, server, events, cut } = await scenario(t, { ...fast, budget: 100 });
  let deliver;
  server.faults.push({ action: 'hello', holdAck: fn => { deliver = fn; } });
  cut();
  await until(() => events.some(x => x.phase === 'stopped'));
  assert.equal(events.find(x => x.phase === 'stopped').code, 'TIMEOUT');
  assert.equal(events.filter(x => x.phase === 'attempt').length, 1);
  deliver(); await sleep(40);
  assert.notEqual(ulda.status, 'open');
  await ulda.reconnect();
  assert.equal(ulda.status, 'open');
});

test('Invalid refresh stops recovery without retries or writes and preserves verified data', { timeout: 10000 }, async t => {
  const { ulda, server, events, masterId, cut } = await scenario(t);
  await ulda.add('item', { value: 1 });
  server.faults.push({ action: 'read', match: ids => ids[0] === masterId, response: response => {
    const data = structuredClone(response); data.data[0].payload[data.data[0].payload.length - 1] ^= 1; return data;
  } });
  const start = server.frames.length;
  cut();
  await until(() => events.some(x => x.phase === 'stopped'));
  assert.equal(events.find(x => x.phase === 'stopped').code, 'CRYPTO_FAILED');
  assert.equal(events.filter(x => x.phase === 'attempt').length, 1);
  assert.equal(ulda.status, 'needsResync');
  assert.equal(ulda.value('item').value, 1);
  assert.equal(writes(server, start).length, 0);
  await ulda.refresh();
  assert.equal(ulda.status, 'open');
});

for (const committed of [true, false]) test(`Lost Update ACK is never replayed (committed=${committed})`, { timeout: 10000 }, async t => {
  const { ulda, server, events, cut } = await scenario(t);
  await ulda.add('item', { value: 0 });
  let deliver;
  server.faults.push(committed ? { action: 'update', holdAck: fn => { deliver = fn; } } : { action: 'update', dropRequest: true });
  const start = server.frames.length;
  const writing = ulda.update('item', { value: 1 });
  const rejected = assert.rejects(writing, { code: 'UNKNOWN_OUTCOME' });
  await until(() => committed ? !!deliver : writes(server, start).length > 0);
  const queued = ulda.update('item', { value: -1 });
  const queuedRejected = assert.rejects(queued, { code: 'NEEDS_RESYNC' });
  cut(); await rejected;
  await queuedRejected;
  await until(() => events.some(x => ['restored', 'stopped'].includes(x.phase)));
  assert.equal(writes(server, start).length, 1);
  assert.equal(ulda.value('item').value, committed ? 1 : 0);
  assert.equal(ulda.status, committed ? 'open' : 'needsResync');
  if (committed) {
    await ulda.update('item', { value: 2 });
    deliver(); await sleep(40);
    assert.equal(ulda.value('item').value, 2);
  }
});

for (const operation of ['register', 'add', 'delete', 'superDelete']) test(`Recovery never repeats ${operation} after a lost ACK`, { timeout: 10000 }, async t => {
  const server = await fixture(), events = [];
  const ulda = new Ulda(server.url, { allowInsecureLocalhost: true, timeout: 500, reconnect: fast });
  ulda.on('reconnect', event => events.push(event));
  t.after(async () => { await ulda.close(); await server.close(); });
  if (operation !== 'register') {
    await ulda.register('synthetic-password');
    await ulda.add('item', { value: 1 });
  } else await ulda.ready;
  const action = ['register', 'add'].includes(operation) ? 'create' : 'delete';
  let deliver;
  server.faults.push({ action, holdAck: fn => { deliver = fn; } });
  const start = server.frames.length;
  const pending = operation === 'register' ? ulda.register('synthetic-password') :
    operation === 'add' ? ulda.add('new', { value: 2 }) :
    operation === 'delete' ? ulda.delete('item') : ulda.superDelete();
  const rejected = assert.rejects(pending, { code: 'UNKNOWN_OUTCOME' });
  await until(() => !!deliver);
  server.io.sockets.sockets.get(server.frames.findLast(x => x.action === action).socket).conn.close();
  await rejected;
  await until(() => events.some(x => ['restored', 'stopped'].includes(x.phase)));
  assert.equal(writes(server, start).length, 1);
  if (operation === 'register') {
    assert.equal(ulda.status, 'ready');
    assert.throws(() => ulda.snapshot(), { code: 'NOT_OPEN' });
  } else if (operation === 'add' || operation === 'superDelete') assert.equal(ulda.status, 'needsResync');
  else { assert.equal(ulda.status, 'open'); assert.deepEqual(Object.keys(ulda.snapshot()), []); }
  const status = ulda.status;
  deliver(); await sleep(40);
  assert.equal(ulda.status, status);
  assert.equal(writes(server, start).length, 1);
});

test('Intentional disconnect cancels a waiting cycle; disabled automatic reconnect stays offline', { timeout: 10000 }, async t => {
  const { ulda, transport, events, cut } = await scenario(t, { ...fast, initialDelay: 100, maxDelay: 100 });
  cut(); await until(() => events.some(x => x.phase === 'waiting'));
  transport.disconnect();
  await sleep(150);
  assert.equal(events.filter(x => x.phase === 'attempt').length, 0);
  assert.equal(ulda.status, 'disconnected');
  await ulda.reconnect(); assert.equal(ulda.status, 'open');

  const other = await scenario(t, false);
  other.cut(); await sleep(150);
  assert.equal(other.events.length, 0);
  assert.equal(other.ulda.status, 'disconnected');
});

test('Close from disconnect callback does not schedule automatic reconnect', { timeout: 10000 }, async t => {
  const { ulda, events, cut } = await scenario(t);
  ulda.on('status', status => { if (status === 'disconnected') ulda.close(); });
  cut(); await until(() => ulda.status === 'closed'); await sleep(100);
  assert.equal(events.length, 0);
});

test('Reconnect options reject unbounded or unknown settings before opening a socket', () => {
  for (const reconnect of [true, { maxAttempts: Infinity }, { maxAttempts: 0 }, { maxDelay: 0 }, { budget: 0 }, { jitter: 2 }, { retries: 3 }]) {
    assert.throws(() => new Ulda('https://invalid.example', { reconnect }), { code: 'INVALID_INPUT' });
  }
});

test('Close during socket handshake cancels the pending connection', { timeout: 10000 }, async t => {
  const { ulda, server, events, cut } = await scenario(t);
  let accept;
  server.io.use((socket, next) => { accept = next; });
  cut(); await until(() => !!accept);
  const joined = ulda.reconnect();
  const rejected = assert.rejects(joined, { code: 'CLOSED' });
  await ulda.close(); await rejected;
  accept(); await sleep(100);
  assert.equal(ulda.status, 'closed');
  assert.equal(events.filter(x => x.phase === 'attempt').length, 1);
  assert.equal(server.io.sockets.sockets.size, 0);
});

test('A second disconnect during refresh retries the read and ignores an old ACK', { timeout: 10000 }, async t => {
  const { ulda, server, events, cut } = await scenario(t);
  await ulda.add('item', { value: 1 });
  let deliver;
  server.faults.push({ action: 'read', holdAck: fn => { deliver = fn; } });
  const start = server.frames.length;
  cut(); await until(() => !!deliver);
  cut();
  await until(() => events.some(x => x.phase === 'restored'));
  assert.equal(events.filter(x => x.phase === 'attempt').length, 2);
  assert.equal(ulda.status, 'open');
  await ulda.update('item', { value: 2 });
  deliver(); await sleep(50);
  assert.equal(ulda.value('item').value, 2);
  assert.equal(writes(server, start).length, 1);
});

test('A disconnect from the restored observer starts a fresh bounded cycle', { timeout: 10000 }, async t => {
  const { ulda, events, cut } = await scenario(t);
  let interrupted = false;
  ulda.on('reconnect', event => {
    if (event.phase === 'restored' && !interrupted) { interrupted = true; cut(); }
  });
  cut();
  await until(() => events.filter(x => x.phase === 'restored').length === 2);
  assert.equal(ulda.status, 'open');
  assert.equal(events.filter(x => x.phase === 'attempt').length, 2);
});

test('Closing immediately from restored does not leave an unhandled stale Proxy promise', { timeout: 10000 }, async t => {
  const { ulda, cut } = await scenario(t);
  let closed;
  ulda.on('reconnect', event => { if (event.phase === 'restored') closed = ulda.close(); });
  cut(); await until(() => !!closed); await closed; await sleep(30);
  assert.equal(ulda.status, 'closed');
});
