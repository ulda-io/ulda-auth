import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { fixture } from './server.js';
import { b64 } from '../src/values.js';

test('real client/server pipeline traces are ordered, private and do not affect operations', async t => {
  const server = await fixture({ diagnostics: true });
  const clients = [], traces = [];
  const client = (diagnostics = true) => {
    const transport = new SocketIoTransport(server.url, { allowInsecureLocalhost: true, diagnostics });
    transport.on('trace', record => traces.push(record));
    const sdk = new Ulda(server.url, { transport });
    sdk.on('trace', record => traces.push(record));
    sdk.on('trace', record => { record.ids.push('999'); });
    clients.push(sdk); return sdk;
  };
  t.after(async () => { for (const sdk of clients) await sdk.close(); await server.close(); });
  const password = 'pipeline-secret-password', name = 'pipeline-secret-name', value = 'pipeline-secret-value';
  const creator = client();
  const master = await creator.register(password); await creator.add(name, { value });
  await creator.close(); traces.length = 0;
  const reader = client(); await reader.connect(master, password);
  const ordered = ['master.read', 'read.lookup', 'read.found', 'read.subscribed', 'master.header', 'master.key.derive', 'master.key.ready', 'master.decrypt', 'master.opened', 'master.catalog', 'content.read', 'content.key', 'content.decrypt', 'content.opened', 'content.staged', 'session.memory'];
  let index = -1;
  for (const step of ordered) { index = traces.findIndex((x, i) => i > index && x.step === step); assert.ok(index >= 0, step); }
  await reader.delete(name); await reader.superDelete();
  for (const step of ['delete.proof', 'catalog.unlink', 'delete.commit', 'write.verified', 'write.committed', 'delete.memory', 'superdelete.commit', 'session.closed'])
    assert.ok(traces.some(x => x.step === step), step);
  const text = JSON.stringify(traces);
  for (const secret of [password, name, value]) assert.equal(text.includes(secret), false);
  for (const frame of server.frames) for (const item of Array.isArray(frame.body) ? frame.body : [])
    for (const field of ['witness', 'payload']) if (item[field]) assert.equal(text.includes(b64(item[field])), false);
  for (const row of traces.filter(x => x.step)) {
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.ids));
    assert.deepEqual(Object.keys(row).sort(), ['count', 'event', 'ids', 'phase', 'step', 'time']);
  }
  traces.length = 0; const quiet = client(false); await quiet.ready;
  assert.equal(traces.some(x => x.phase === 'server'), false);
});

test('server diagnostic input cannot echo arbitrary fields/text and failed decrypt has no success steps', async t => {
  const server = await fixture({ diagnostics: true });
  const traces = [], clients = [];
  const client = () => {
    const transport = new SocketIoTransport(server.url, { allowInsecureLocalhost: true, diagnostics: true });
    transport.on('trace', x => traces.push(x));
    const sdk = new Ulda(server.url, { transport }); sdk.on('trace', x => traces.push(x)); clients.push(sdk); return sdk;
  };
  t.after(async () => { for (const sdk of clients) await sdk.close(); await server.close(); });
  const sdk = client(); const id = await sdk.register('original-synthetic-password');
  await sdk.close(); traces.length = 0;
  const wrong = client(); await wrong.ready;
  for (const socket of server.io.sockets.sockets.values()) {
    socket.emit('ulda:diagnostic', { action: 'read', step: 'private-reflected-secret', ids: [], count: 0 });
    socket.emit('ulda:diagnostic', { action: 'read', step: 'read.lookup', ids: [], count: 0, payload: 'private-reflected-secret' });
    socket.emit('ulda:diagnostic', { action: 'read', step: 'read.lookup', ids: ['private-reflected-secret'], count: 0 });
  }
  await assert.rejects(wrong.connect(id, 'wrong-synthetic-password'), { code: 'CRYPTO_FAILED' });
  assert.ok(traces.some(x => x.step === 'master.decrypt'));
  for (const step of ['master.opened', 'master.catalog', 'content.read', 'session.memory']) assert.equal(traces.some(x => x.step === step), false);
  assert.equal(JSON.stringify(traces).includes('private-reflected-secret'), false);
});
