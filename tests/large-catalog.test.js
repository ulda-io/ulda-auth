import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda } from '../src/index.js';
import { newOrigin } from '../src/core.js';
import { masterCredentials, newContentSecret, newToken, seal, sealedWire, open } from '../src/crypto.js';
import { ChangeAssembly, fragments } from '../src/transfer.js';
import { json, LIMITS } from '../src/values.js';
import { fixture } from './server.js';

test('a 10000-entry catalog passes encryption and verification without weakening content JSON limits', async () => {
  const data = { contents: Array.from({ length: 10000 }, (_, i) => ({ id: String(i + 1), name: `entry-${i}`, key: newContentSecret(), token: newToken() })) };
  assert.throws(() => json(data), { code: 'LIMIT' });
  const credentials = await masterCredentials(crypto.randomUUID()), origin = newOrigin('X'), token = newToken();
  try {
    const record = { id: '10001', ...sealedWire(await seal(credentials, token, origin, data, true)) };
    assert.ok(record.payload.length > LIMITS.payloadBytes);
    const decoded = await open(credentials, record, token, true);
    assert.equal(decoded.data.contents.length, 10000);
    assert.equal(decoded.data.contents[9999].name, 'entry-9999');
    decoded.origin.fill(0);
    await assert.rejects(open(credentials, record, token), { code: 'CRYPTO_FAILED' });
  } finally { origin.fill(0); }
});

test('more than 64 content are opened using bounded reads; corrupt last batch preserves the checked local copy', async t => {
  const server = await fixture(), a = new Ulda(server.url, { allowInsecureLocalhost: true }), b = new Ulda(server.url, { allowInsecureLocalhost: true });
  t.after(async () => { await a.close(); await b.close(); await server.close(); });
  const password = crypto.randomUUID(), master = await a.register(password);
  for (let i = 0; i < 130; i++) await a.add(`entry-${i}`, { n: i });
  await b.connect(master, password);
  assert.equal(Object.keys(b.snapshot()).length, 130);
  assert.equal(b.value('entry-129').n, 129);
  const last = [...server.records.values()].at(-1);
  last.payload = last.payload.slice(); last.payload[last.payload.length - 1] ^= 1;
  await assert.rejects(b.refresh(), { code: 'CRYPTO_FAILED' });
  assert.equal(b.value('entry-0').n, 0); assert.equal(b.value('entry-129').n, 129);
});

test('Changed parts remain unpublished until complete and reject reordered, mismatched and excessive frames', () => {
  const payload = new Uint8Array(2_200_000).fill(27), witness = Uint8Array.of(1);
  const assembly = new ChangeAssembly(2);
  assembly.accept({ kind: 'append', items: [{ id: '1' }] });
  const pieces = [...fragments([{ id: '2', witness, payload }])];
  assembly.accept(pieces[0]);
  assert.throws(() => assembly.finish(), { code: 'INVALID_PACKET' });
  assert.throws(() => assembly.accept(pieces[0]), { code: 'INVALID_PACKET' });
  for (const piece of pieces.slice(1)) assembly.accept(piece);
  const result = assembly.finish();
  assert.deepEqual(result.deleted, ['1']); assert.deepEqual(result.updated[0].payload, payload);
  assert.throws(() => new ChangeAssembly(Number.MAX_SAFE_INTEGER), { code: 'LIMIT' });
  const invalid = new ChangeAssembly(1);
  assert.throws(() => invalid.accept({ ...pieces[0], total: LIMITS.resourceBytes + 1 }), { code: 'LIMIT' });
  assert.throws(() => invalid.accept({ ...pieces[0], offset: 1 }), { code: 'LIMIT' });
});

test('temporary read admission failure does not split or replay and preserves the complete checked catalog', async t => {
  const server = await fixture(), ulda = new Ulda(server.url, { allowInsecureLocalhost: true });
  const writer = new Ulda(server.url, { allowInsecureLocalhost: true });
  t.after(async () => { await ulda.close(); await writer.close(); await server.close(); });
  const password = crypto.randomUUID(), master = await ulda.register(password);
  for (let i = 0; i < 65; i++) await ulda.add(`entry-${i}`, { n: i });
  const before = ulda.snapshot(), finalId = [...server.records.keys()].at(-1);
  await writer.connect(master, password);
  server.faults.push({ action: 'update', dropChanged: true });
  await writer.update('entry-0', { n: 1000 });
  assert.equal(ulda.value('entry-0').n, 0);
  // The first group now contains a valid newer value. Failure in the last group
  // must not expose that value before the whole refresh has been verified.
  server.faults.push({ action: 'read', match: ids => ids.includes(finalId), error: 'not_ready' });
  const start = server.frames.length;
  await assert.rejects(ulda.refresh(), { code: 'SERVER_ERROR' });
  assert.deepEqual(ulda.snapshot(), before);
  const frames = server.frames.slice(start);
  assert.deepEqual(frames.map(x => [x.action, x.body.length]), [['read', 1], ['read', 64], ['read', 1]]);
  // A deliberate later refresh succeeds. The failed command triggered neither
  // singleton transfer fallback nor an automatic read/write retry.
  await ulda.refresh();
  assert.equal(ulda.value('entry-0').n, 1000);
  assert.deepEqual(ulda.snapshot(), writer.snapshot());
});
