import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { fixture } from './server.js';

const outcome = promise => promise.then(() => 'success', error => error.code);
function hold(server, action, match) {
  let release;
  const held = new Promise(resolve => server.faults.push({ action, match, holdAck: send => { release = send; resolve(); } }));
  return { held, release: () => release?.() };
}
async function setup(t) {
  const server = await fixture(), clients = [];
  const client = () => {
    const transport = new SocketIoTransport(server.url, { allowInsecureLocalhost: true, timeout: 1500 });
    const ulda = new Ulda(server.url, { transport, reconnect: false });
    clients.push(ulda); return { ulda, transport };
  };
  t.after(async () => { for (const ulda of clients) await ulda.close(); await server.close(); });
  const password = randomUUID(), { ulda, transport } = client();
  const masterId = await ulda.register(password); await ulda.add('note', { value: 1 });
  const contentRecord = structuredClone([...server.records.values()].find(x => x.id !== masterId));
  return { server, client, ulda, transport, password, masterId, contentRecord };
}
async function fault(server, ulda, kind = 'malformed', record) {
  const expected = kind === 'malformed' ? 'INVALID_PACKET' : 'LIMIT';
  const received = new Promise(resolve => {
    const off = ulda.on('error', error => { if (error.code === expected) { off(); resolve(); } });
  });
  if (kind === 'malformed') server.sendChanged({ updated: [], deleted: [], extra: true });
  else for (let i = 0; i < 10; i++) server.sendChanged({ updated: [record], deleted: [] });
  await received;
  assert.equal(ulda.status, 'needsResync');
}
const writes = (server, start) => server.frames.slice(start).filter(x => ['create', 'update', 'delete'].includes(x.action));

for (const operation of ['refresh', 'connect', 'reconnect']) for (const kind of ['malformed', 'overflow'])
test(`${operation} cannot clear a concurrent ${kind} integrity fault`, { timeout: 10000 }, async t => {
  const ctx = await setup(t), { server, masterId, password, contentRecord } = ctx;
  const { ulda, transport } = operation === 'connect' ? ctx.client() : ctx;
  await ulda.ready;
  if (operation === 'reconnect') transport.disconnect();
  const gate = hold(server, 'read', ids => !ids.includes(masterId)); t.after(gate.release);
  const events = []; ulda.on('reconnect', event => events.push(event));
  const result = outcome(operation === 'connect' ? ulda.connect(masterId, password) : ulda[operation]());
  await gate.held; await fault(server, ulda, kind, contentRecord);
  const start = server.frames.length; gate.release();
  assert.equal(await result, 'NEEDS_RESYNC');
  assert.equal(ulda.status, 'needsResync');
  assert.equal(writes(server, start).length, 0);
  if (operation === 'connect') {
    assert.throws(() => ulda.snapshot(), { code: 'NOT_OPEN' });
    await ulda.connect(masterId, password);
  } else {
    assert.equal(ulda.value('note').value, 1);
    assert.throws(() => ulda.update('note', { value: 2 }), { code: 'NEEDS_RESYNC' });
    if (operation === 'reconnect') {
      assert.equal(events.filter(x => x.phase === 'attempt').length, 1);
      assert.equal(events.some(x => x.phase === 'restored'), false);
    }
    await ulda.refresh();
  }
  assert.equal(ulda.status, 'open');
  await ulda.update('note', { value: 3 });
  assert.equal(ulda.value('note').value, 3);
});

for (const operation of ['add', 'recoverContent']) test(`${operation} retains its Create ACK but does not send Update after a fault`, { timeout: 10000 }, async t => {
  const { server, ulda } = await setup(t);
  const gate = hold(server, 'create'); t.after(gate.release);
  const createsBefore = server.frames.filter(x => x.action === 'create').length;
  const result = outcome(operation === 'add' ? ulda.add('new-note', { value: 2 }) : ulda.recoverContent('note'));
  await gate.held; await fault(server, ulda);
  const start = server.frames.length; gate.release();
  assert.equal(await result, 'NEEDS_RESYNC');
  assert.equal(writes(server, start).length, 0);
  assert.equal(ulda.status, 'needsResync'); assert.equal(ulda.value('note').value, 1);
  if (operation === 'add') { await ulda.refresh(); await ulda.add('new-note', { value: 2 }); }
  else await ulda.recoverContent('note');
  assert.equal(ulda.status, 'open');
  assert.equal(server.frames.filter(x => x.action === 'create').length, createsBefore + 1);
});

for (const operation of ['register', 'add', 'update', 'delete', 'recoverContent'])
test(`${operation} stops a not-yet-sent mutation when a fault arrives during preparation`, { timeout: 10000 }, async t => {
  const ctx = await setup(t), { server } = ctx;
  const ulda = operation === 'register' ? ctx.client().ulda : ctx.ulda; await ulda.ready;
  // Pause native crypto after the result is computed, before SDK can send it.
  const real = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let release, entered, first = true;
  const held = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const method = 'encrypt';
  const subtle = new Proxy(real.subtle, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === method) return async (...args) => {
      const result = await value.apply(target, args);
      if (first) { first = false; entered(); await waiting; }
      return result;
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: x => real.getRandomValues(x) } });
  t.after(() => { release(); Object.defineProperty(globalThis, 'crypto', descriptor); });
  const start = server.frames.length;
  const args = operation === 'register' ? [randomUUID()] : operation === 'add' ? ['new-note', {}] : operation === 'update' ? ['note', {}] : operation === 'superDelete' ? [] : ['note'];
  const result = outcome(ulda[operation](...args));
  await held; await fault(server, ulda); release();
  assert.equal(await result, 'NEEDS_RESYNC');
  assert.equal(writes(server, start).length, 0);
  assert.equal(ulda.status, 'needsResync');
});

for (const operation of ['register', 'add', 'update', 'recoverContent']) test(`${operation} preserves an already-sent commit without clearing a later fault`, { timeout: 10000 }, async t => {
  const ctx = await setup(t), { server } = ctx;
  const ulda = operation === 'register' ? ctx.client().ulda : ctx.ulda; await ulda.ready;
  const gate = hold(server, operation === 'register' ? 'create' : 'update'); t.after(gate.release);
  const args = operation === 'register' ? [randomUUID()] : operation === 'add' ? ['new-note', { value: 2 }] : operation === 'update' ? ['note', { value: 2 }] : ['note'];
  const result = outcome(ulda[operation](...args));
  await gate.held; await fault(server, ulda); const start = server.frames.length; gate.release();
  assert.equal(await result, 'success');
  assert.equal(ulda.status, 'needsResync');
  assert.equal(writes(server, start).length, 0);
  await ulda.refresh(); assert.equal(ulda.status, 'open');
});

test('A lost Update ACK stays unknown after an integrity fault and is never replayed', { timeout: 10000 }, async t => {
  const { ulda, server } = await setup(t);
  const gate = hold(server, 'update'); t.after(gate.release);
  const result = outcome(ulda.update('note', { value: 2 }));
  await gate.held; await fault(server, ulda); const start = server.frames.length;
  assert.equal(await result, 'UNKNOWN_OUTCOME');
  await ulda.refresh(); assert.equal(ulda.value('note').value, 2);
  gate.release(); assert.equal(writes(server, start).length, 0);
});

for (const operation of ['delete', 'superDelete']) test(operation + ' stops before mutation if preflight gets a concurrent fault', { timeout: 10000 }, async t => {
  const { ulda, server, masterId } = await setup(t);
  const gate = hold(server, 'read', ids => !ids.includes(masterId)); t.after(gate.release);
  const start = server.frames.length;
  const result = outcome(ulda[operation](...(operation === 'delete' ? ['note'] : [])));
  await gate.held; await fault(server, ulda); gate.release();
  assert.equal(await result, 'NEEDS_RESYNC');
  assert.equal(ulda.status, 'needsResync');
  assert.equal(ulda.value('note').value, 1);
  assert.equal(writes(server, start).length, 0);
  await ulda.refresh(); assert.equal(ulda.status, 'open');
});

test('An integrity fault during Hello cannot be cleared by its delayed ACK', { timeout: 10000 }, async t => {
  const ctx = await setup(t), { server } = ctx;
  const gate = hold(server, 'hello'); t.after(gate.release);
  const { ulda } = ctx.client(); const ready = outcome(ulda.ready);
  await gate.held; await fault(server, ulda); const start = server.frames.length; gate.release();
  assert.equal(await ready, 'NEEDS_RESYNC'); assert.equal(ulda.status, 'needsResync');
  assert.equal(await outcome(ulda.register(randomUUID())), 'NEEDS_RESYNC');
  assert.equal(writes(server, start).length, 0);
  await ulda.reconnect(); assert.equal(ulda.status, 'ready');
  await ulda.register(randomUUID()); assert.equal(ulda.status, 'open');
});

test('A fault on a ready connection blocks a new registration until explicit recovery', { timeout: 10000 }, async t => {
  const ctx = await setup(t), { server } = ctx;
  const { ulda } = ctx.client(); await ulda.ready;
  await fault(server, ulda); const start = server.frames.length;
  assert.equal(await outcome(ulda.register(randomUUID())), 'NEEDS_RESYNC');
  assert.equal(writes(server, start).length, 0);
  await ulda.reconnect(); await ulda.register(randomUUID()); assert.equal(ulda.status, 'open');
});
