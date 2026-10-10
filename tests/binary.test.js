import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binary, b64, LIMITS } from '../src/values.js';
import { contentCredentials, newContentSecret, newToken, seal, sealedWire, open } from '../src/crypto.js';
import { newOrigin, advance } from '../src/core.js';
import { writePacket, outgoing, resource, readPacket, emptyPacket, deletePacket, deletionProof } from '../src/protocol.js';
import { SocketIoTransport } from '../src/index.js';
import { fixture } from './server.js';

test('binary input respects view bounds and rejects strings, fake buffers and shared memory', () => {
  const source = new Uint8Array([99, 1, 2, 98]);
  assert.deepEqual([...binary(source.subarray(1, 3))], [1, 2]);
  assert.deepEqual([...binary(new Uint8Array([1, 2]).buffer)], [1, 2]);
  assert.deepEqual([...binary(Buffer.from(source).subarray(1, 3))], [1, 2]);
  for (const value of ['AQI', [1, 2], {type:'Buffer',data:[1, 2]}, new Uint16Array([1]),
    new DataView(source.buffer), new Uint8Array(0), new Uint8Array(new SharedArrayBuffer(2)),
    new Uint8Array(LIMITS.payloadBytes + 1)])
    assert.throws(() => binary(value), { code:'INVALID_PACKET' });
});

test('opaque sealed handles, outgoing packets and received resources do not share mutable binary buffers', async () => {
  const credentials = await contentCredentials(newContentSecret()), token = newToken(), origin = newOrigin();
  const sealed = await seal(credentials, token, origin, { secret:'binary-private-marker' });
  const original = sealedWire(sealed), exposed = sealedWire(sealed);
  exposed.payload.fill(0); exposed.witness.fill(0);
  assert.deepEqual(sealedWire(sealed), original);
  const packet = writePacket('create', [{ sealed }]);
  const sent = outgoing(packet); sent.body[0].payload.fill(0); sent.body[0].witness.fill(0);
  assert.deepEqual(outgoing(packet).body[0], original);
  const raw = { id:'1', ...sealedWire(sealed) }, received = resource(raw);
  raw.payload.fill(0); raw.witness.fill(0);
  assert.equal((await open(credentials, received, token)).data.secret, 'binary-private-marker');
  for (const key of ['witness', 'payload']) {
    assert.throws(() => resource({ id:'1', ...original, [key]:b64(original[key]) }), {code:'INVALID_PACKET'});
    // Socket.IO's browser decoder returns ArrayBuffers; its Node decoder returns Buffers.
    assert.deepEqual(resource({id:'1',...original,[key]:Buffer.from(original[key])})[key], original[key]);
    assert.deepEqual(resource({id:'1',...original,[key]:original[key].slice().buffer})[key], original[key]);
  }
});

test('Socket.IO carries raw binary attachments for requests, Read ACK and Changed', async t => {
  const server = await fixture();
  const receivedFrames = [], sentFrames = [];
  server.io.on('connection', socket => {
    socket.conn.on('packet', packet => { if (packet.type === 'message') receivedFrames.push(packet.data); });
    socket.conn.on('packetCreate', packet => { if (packet.type === 'message') sentFrames.push(packet.data); });
  });
  const transport = new SocketIoTransport(server.url, {allowInsecureLocalhost:true});
  t.after(async () => { transport.close(); await server.close(); });
  await transport.start();
  const credentials = await contentCredentials(newContentSecret()), token = newToken(), origin = newOrigin();
  const sealed = await seal(credentials, token, origin, {secret:'not-on-wire'});
  const original = sealedWire(sealed);
  const [id] = await transport.send(writePacket('create', [{sealed}]));
  assert.ok(receivedFrames.some(x => typeof x === 'string' && x.startsWith('52-') && x.includes('ulda:create') && x.includes('"_placeholder":true')));
  assert.deepEqual(receivedFrames.filter(x => typeof x !== 'string').map(x => new Uint8Array(x)), [original.witness, original.payload]);
  assert.ok(receivedFrames.filter(x => typeof x === 'string').every(x => !x.includes(b64(original.payload)) && !x.includes('not-on-wire')));
  const [read] = await transport.send(readPacket([id]));
  assert.deepEqual(read.payload, original.payload);
  assert.ok(sentFrames.some(x => typeof x === 'string' && x.startsWith('62-')));
  const changes = []; transport.on('changed', value => changes.push(value));
  const writer = new SocketIoTransport(server.url, {allowInsecureLocalhost:true});
  t.after(() => writer.close()); await writer.start();
  await writer.send(writePacket('update', [{id,sealed:await seal(credentials,token,advance(origin),{secret:'next-private'})}]));
  await transport.send(emptyPacket('hello'));
  assert.ok(sentFrames.some(x => typeof x === 'string' && x.startsWith('52-') && x.includes('ulda:changed')));
  assert.equal((await open(credentials, changes[0].updated[0], token)).data.secret, 'next-private');
});

test('Maximum 64-resource binary batch supports Create, Read, atomic Update, Changed and Delete', { timeout: 10000 }, async t => {
  const server = await fixture();
  const writer = new SocketIoTransport(server.url, { allowInsecureLocalhost: true });
  const reader = new SocketIoTransport(server.url, { allowInsecureLocalhost: true });
  t.after(async () => { writer.close(); reader.close(); await server.close(); });
  await Promise.all([writer.start(), reader.start()]);
  const states = [];
  for (let i = 0; i < LIMITS.batch; i++) {
    const credentials = await contentCredentials(newContentSecret()), token = newToken(), origin = newOrigin();
    states.push({ credentials, token, origin, sealed: await seal(credentials, token, origin, { value: 0 }) });
  }
  const ids = await writer.send(writePacket('create', states.map(({ sealed }) => ({ sealed }))));
  assert.equal(ids.length, LIMITS.batch);
  assert.equal((await reader.send(readPacket(ids))).length, LIMITS.batch);
  const changed = new Promise(resolve => reader.on('changed', resolve));
  const updates = [];
  for (let i = 0; i < ids.length; i++) {
    states[i].origin = advance(states[i].origin);
    updates.push({ id: ids[i], sealed: await seal(states[i].credentials, states[i].token, states[i].origin, { value: 1 }) });
  }
  await writer.send(writePacket('update', updates));
  const event = await changed;
  assert.equal(event.updated.length, LIMITS.batch);
  assert.equal((await open(states.at(-1).credentials, event.updated.at(-1), states.at(-1).token)).data.value, 1);
  assert.deepEqual(server.commits.at(-1), { action: 'update', ids });
  const proofs = [];
  for (let i = 0; i < ids.length; i++) proofs.push(await deletionProof(ids[i], states[i].origin));
  await writer.send(deletePacket(proofs));
  assert.equal(server.records.size, 0);
});
