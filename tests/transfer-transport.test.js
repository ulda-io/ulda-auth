import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { SocketIoTransport } from '../src/transport.js';
import { socketParser } from '../src/socket-parser.js';
import { contentCredentials, newContentSecret, newToken, seal } from '../src/crypto.js';
import { newOrigin } from '../src/core.js';
import { writePacket } from '../src/protocol.js';

async function packet() {
  const origin = newOrigin('X');
  try {
    const sealed = await seal(await contentCredentials(newContentSecret()), newToken(), origin, { text: 'x'.repeat(1200000) }, true);
    return writePacket('update', [{ id: '1', sealed }]);
  } finally { origin.fill(0); }
}
for (const failure of ['begin', 'append', 'commit', 'invalid-commit']) test(`extended ${failure} ACK failure never replays a mutation`, async t => {
  const http = createServer(), server = new Server(http, { transports: ['websocket'], parser: socketParser, maxHttpBufferSize: 2000000 });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const transport = new SocketIoTransport(`http://127.0.0.1:${http.address().port}`, { timeout: 1000, allowInsecureLocalhost: true });
  t.after(async () => { transport.close(); await new Promise(resolve => server.close(resolve)); });
  let commits = 0, begins = 0, disconnects = 0;
  server.on('connection', socket => {
    socket.on('disconnect', () => disconnects++);
    socket.on('ulda:transfer', (body, ack) => {
      if (body.kind === 'begin') { begins++; if (failure !== 'begin') ack({ ok: true, token: 'a'.repeat(32) }); }
      else if (body.kind === 'part' || body.kind === 'append') { if (failure !== 'append') ack({ ok: true }); }
      else if (body.kind === 'commit') {
        commits++;
        if (failure === 'invalid-commit') ack({ ok: true, unexpected: 'synthetic-private-detail' });
        else if (failure !== 'commit') ack({ ok: true });
      }
    });
  });
  await transport.start();
  await assert.rejects(transport.send(await packet()), { code: failure === 'commit' || failure === 'invalid-commit' ? 'UNKNOWN_OUTCOME' : 'TIMEOUT' });
  assert.equal(transport.connected, false);
  await transport.start();
  assert.equal(begins, 1); assert.equal(commits, failure === 'commit' || failure === 'invalid-commit' ? 1 : 0);
  assert.ok(disconnects >= 1);
});
