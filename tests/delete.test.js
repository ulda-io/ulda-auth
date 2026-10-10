import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { fixture } from './server.js';
import { newOrigin, advance } from '../src/core.js';
import { contentCredentials, newContentSecret, newToken, seal } from '../src/crypto.js';
import { writePacket, deletePacket, deletionProof, outgoing, requestShape } from '../src/protocol.js';

async function setup(t, timeout = 1000) {
  const server = await fixture();
  const clients = [];
  const client = () => { const sdk = new Ulda(server.url, { allowInsecureLocalhost: true, timeout }); clients.push(sdk); return sdk; };
  t.after(async () => { for (const sdk of clients) await sdk.close(); await server.close(); });
  const sdk = client(), password = 'synthetic-delete-password';
  const master = await sdk.register(password);
  await sdk.add('private-delete-name', { secret: 'synthetic-private-value' });
  const content = [...server.records.keys()].find(id => id !== master);
  return { sdk, client, server, password, master, content };
}
async function until(fn) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Condition not reached');
}
test('delete removes the content and encrypted catalog entry for both subscribers; reopen works', async t => {
  const { sdk, client, server, password, master, content } = await setup(t);
  const other = client(); await other.connect(master, password);
  await sdk.data['private-delete-name'].delete();
  assert.equal(server.records.has(content), false);
  assert.equal(server.records.has(master), true);
  assert.deepEqual(Object.keys(sdk.snapshot()), []);
  await until(() => Object.keys(other.snapshot()).length === 0);
  assert.equal(server.watchers.has(content), false);
  const packet = server.frames.find(x => x.action === 'delete').body;
  assert.deepEqual(Object.keys(packet[0]).sort(), ['id', 'witness']);
  assert.deepEqual(Object.keys(packet[1]).sort(), ['id', 'payload', 'witness']);
  assert.equal(packet[1].id, master);
  assert.equal(JSON.stringify(packet).includes('private-delete-name'), false);
  const reopened = client(); await reopened.connect(master, password);
  assert.deepEqual(Object.keys(reopened.snapshot()), []);
  await reopened.add('new-content', {});
  assert.deepEqual(Object.keys(reopened.snapshot()), ['new-content']);
});

test('mixed Delete verifies every witness before deleting anything; duplicate IDs and raw payload rejected', async t => {
  const server = await fixture();
  const transport = new SocketIoTransport(server.url, { allowInsecureLocalhost: true });
  t.after(async () => { transport.close(); await server.close(); }); await transport.start();
  const credentials = await contentCredentials(newContentSecret()), token = newToken();
  const firstOrigin = newOrigin('X'), secondOrigin = newOrigin('X');
  const first = await seal(credentials, token, firstOrigin, {}), second = await seal(credentials, token, secondOrigin, {});
  const [a, b] = await transport.send(writePacket('create', [{ sealed: first }, { sealed: second }]));
  const proof = await deletionProof(a, firstOrigin);
  const original = JSON.stringify([...server.records]);
  // The first proof is valid; the second item deliberately keeps the old witness.
  await assert.rejects(transport.send(deletePacket([proof], [{ id: b, sealed: second }])), { code: 'CONFLICT' });
  assert.equal(JSON.stringify([...server.records]), original);
  const advanced = await seal(credentials, token, advance(secondOrigin), { updated: true });
  const valid = deletePacket([proof], [{ id: b, sealed: advanced }]);
  assert.throws(() => deletePacket([proof], [{ id: a, sealed: advanced }]), { code: 'INVALID_PACKET' });
  assert.throws(() => deletePacket([proof], [{ id: b, sealed: { payload: 'private plaintext' } }]), { code: 'INVALID_PACKET' });
  assert.throws(() => requestShape('delete', outgoing(writePacket('update', [{ id: b, sealed: advanced }])).body), { code: 'INVALID_PACKET' });
  await transport.send(valid);
  assert.equal(server.records.has(a), false); assert.equal(server.records.has(b), true);
});

for (const dropRequest of [false, true]) test(`unknown Delete is not replayed; ${dropRequest ? 'uncommitted state stays blocked' : 'committed state is recovered by Read'}`, async t => {
  const { sdk, server, content } = await setup(t, 250);
  server.faults.push({ action: 'delete', dropRequest, dropAck: !dropRequest, dropChanged: true });
  await assert.rejects(sdk.delete('private-delete-name'), { code: 'UNKNOWN_OUTCOME' });
  assert.equal(server.records.has(content), dropRequest);
  assert.throws(() => sdk.add('blocked', {}), { code: 'NEEDS_RESYNC' });
  await sdk.refresh();
  assert.equal(server.frames.filter(x => x.action === 'delete').length, 1);
  if (dropRequest) {
    assert.equal(sdk.status, 'needsResync');
    assert.deepEqual(Object.keys(sdk.snapshot()), ['private-delete-name']);
  } else {
    assert.equal(sdk.status, 'open'); assert.deepEqual(Object.keys(sdk.snapshot()), []);
  }
});

test('Delete rejection leaves content/catalog intact and prevents blind continuation', async t => {
  const { sdk, server } = await setup(t);
  const original = JSON.stringify([...server.records]);
  server.faults.push({ action: 'delete', error: 'conflict' });
  await assert.rejects(sdk.delete('private-delete-name'), { code: 'CONFLICT' });
  assert.equal(JSON.stringify([...server.records]), original);
  assert.equal(sdk.status, 'needsResync');
  await sdk.refresh(); await sdk.delete('private-delete-name');
  assert.deepEqual(Object.keys(sdk.snapshot()), []);
});
