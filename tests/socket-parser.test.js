import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketParser, SOCKET_HEADER_BYTES } from '../src/socket-parser.js';
import { LIMITS } from '../src/values.js';

function encoded(buffers) {
  return new socketParser.Encoder().encode({ type: 2, nsp: '/', data: ['test', buffers] });
}

test('Socket decoder accepts 128 attachments, rejects 129 before reconstruction and resets on error', () => {
  const decoder = new socketParser.Decoder(), received = [];
  decoder.on('decoded', packet => received.push(packet));
  const permitted = encoded(Array.from({ length: 128 }, () => new Uint8Array([1])));
  for (const frame of permitted) decoder.add(frame);
  assert.equal(received.length, 1);
  assert.equal(received[0].data[1].length, 128);
  const excessive = encoded(Array.from({ length: 129 }, () => new Uint8Array([1])));
  assert.throws(() => decoder.add(excessive[0]), /too many attachments/);
  assert.equal(received.length, 1);
  for (const frame of permitted) decoder.add(frame);
  assert.equal(received.length, 2);
});

test('Socket decoder bounds accumulated attachment bytes before accepting the final frame', () => {
  const decoder = new socketParser.Decoder(), received = [];
  decoder.on('decoded', packet => received.push(packet));
  const chunk = new Uint8Array(LIMITS.messageBytes / 8);
  const full = encoded(Array.from({ length: 8 }, () => chunk));
  for (const frame of full) decoder.add(frame);
  assert.equal(received.length, 1);
  const excessive = encoded([...Array.from({ length: 8 }, () => chunk), new Uint8Array([1])]);
  for (const frame of excessive.slice(0, -1)) decoder.add(frame);
  assert.throws(() => decoder.add(excessive.at(-1)), { code: 'LIMIT' });
  assert.equal(received.length, 1);
  // The rejected partial packet is discarded, not retained for the next packet.
  for (const frame of full) decoder.add(frame);
  assert.equal(received.length, 2);
});

test('Socket decoder bounds each frame and UTF-8 header, including cleanup on disconnect', () => {
  const decoder = new socketParser.Decoder(), received = [];
  decoder.on('decoded', packet => received.push(packet));
  assert.throws(() => decoder.add('x'.repeat(SOCKET_HEADER_BYTES + 1)), { code: 'LIMIT' });
  assert.throws(() => decoder.add('я'.repeat(SOCKET_HEADER_BYTES / 2 + 1)), { code: 'LIMIT' });
  const oversized = encoded([new Uint8Array(LIMITS.payloadBytes + 1)]);
  decoder.add(oversized[0]);
  assert.throws(() => decoder.add(oversized[1]), { code: 'INVALID_PACKET' });
  const partial = encoded([new Uint8Array([1]), new Uint8Array([2])]);
  decoder.add(partial[0]); decoder.add(partial[1]);
  decoder.destroy();
  for (const frame of encoded([new Uint8Array([3])])) decoder.add(frame);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data[1], [new Uint8Array([3])]);
});
