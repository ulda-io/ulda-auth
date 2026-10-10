import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { inspectTar } from '../scripts/tar-entries.js';

function header(path, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(path, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.fill(32, 148, 156); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  h.write(h.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function rawTar(entries) {
  return Buffer.concat([...entries.flatMap(({ path = 'safe.txt', bytes = Buffer.from('safe'), type = '0' }) =>
    [header(path, bytes.length, type), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]), Buffer.alloc(1024)]);
}
const tar = entries => gzipSync(rawTar(entries));
function pax(value) {
  const body = 'comment=' + value + '\n'; let length = Buffer.byteLength(body) + 2;
  while (Buffer.byteLength(String(length) + ' ' + body) !== length) length = Buffer.byteLength(String(length) + ' ' + body);
  return Buffer.from(String(length) + ' ' + body);
}
function scanner(t) {
  const folder = mkdtempSync(join(tmpdir(), 'ulda-scanner-'));
  t.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('ulda-scanner-'));
    rmSync(folder, { recursive: true, force: true });
  });
  mkdirSync(join(folder, 'scripts'));
  for (const name of ['check-secrets.js', 'tar-entries.js', 'secret-patterns.js']) copyFileSync(resolve('scripts', name), join(folder, 'scripts', name));
  writeFileSync(join(folder, 'scripts/secret-scan-allowlist.json'), '[]');
  writeFileSync(join(folder, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, NODE_OPTIONS: '', DEBUG: '' }; delete env.NODE_TEST_CONTEXT;
  const init = spawnSync('git', ['init', '--quiet'], { cwd: folder, env, encoding: 'utf8' });
  assert.equal(init.status, 0);
  return (bytes, marker, expected) => {
    writeFileSync(join(folder, 'synthetic.gz'), bytes);
    const result = spawnSync(process.execPath, ['scripts/check-secrets.js'], { cwd: folder, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected);
    assert.equal((result.stdout + result.stderr).includes(marker), false, 'Synthetic credential must not appear in diagnostics');
    return result;
  };
}
const token = () => ['npm', '_', crypto.randomUUID().replaceAll('-', '')].join('');

test('Full scanner accepts supported tar and detects a synthetic token inside it', t => {
  const run = scanner(t), marker = token();
  run(tar([{ bytes: Buffer.from('safe') }]), marker, 0);
  const result = run(tar([{ bytes: Buffer.from(marker) }]), marker, 1);
  assert.ok(JSON.parse(result.stdout).details.some(x => x.rule === 'npm-token'));
});

test('Plain gzip cannot pass as an empty inspected tar', t => {
  const run = scanner(t), marker = token();
  for (const bytes of [Buffer.from(marker), Buffer.from(marker.padEnd(2048, ' '))]) {
    const result = run(gzipSync(bytes), marker, 1);
    assert.ok(result.stderr.includes('did not complete'));
  }
});

for (const type of ['x', 'g']) test(`Full scanner rejects unsupported PAX metadata ${type}`, t => {
  const run = scanner(t), marker = token();
  run(tar([{ path: 'metadata', bytes: pax(marker), type }, {}]), marker, 1);
});

test('Full scanner inspects supported tar header metadata including directory names', t => {
  const run = scanner(t), marker = token();
  const result = run(tar([{ path: marker, type: '5', bytes: Buffer.alloc(0) }, {}]), marker, 1);
  assert.ok(JSON.parse(result.stdout).details.some(x => x.rule === 'npm-token'));
});

for (const variant of ['checksum', 'terminator', 'trailing', 'padding', 'size', 'duplicate', 'directory-data'])
test(`Invalid tar ${variant} fails the complete scanner`, t => {
  const run = scanner(t), marker = token();
  let raw = rawTar([{}]);
  if (variant === 'checksum') raw[100] ^= 1;
  if (variant === 'terminator') raw = raw.subarray(0, raw.length - 512);
  if (variant === 'trailing') raw = Buffer.concat([raw, Buffer.from(marker)]);
  if (variant === 'padding') raw[520] = 1;
  if (variant === 'size') raw = Buffer.concat([header('safe.txt', 9000), Buffer.alloc(1024)]);
  if (variant === 'duplicate') raw = rawTar([{}, {}]);
  if (variant === 'directory-data') raw = rawTar([{ type: '5', bytes: Buffer.from(marker) }]);
  run(gzipSync(raw), marker, 1);
});

test('Nested tar content is scanned and excessive depth fails closed', t => {
  const run = scanner(t), marker = token();
  const result = run(tar([{ path: 'nested.tgz', bytes: tar([{ bytes: Buffer.from(marker) }]) }]), marker, 1);
  assert.ok(JSON.parse(result.stdout).details.some(x => x.rule === 'npm-token'));
  let archive = tar([{}]);
  for (let depth = 0; depth < 4; depth++) archive = tar([{ path: 'nested.tgz', bytes: archive }]);
  const limited = run(archive, marker, 1);
  assert.ok(limited.stderr.includes('did not complete'));
});

test('Archive expansion honors the remaining budget before retaining unbounded output', () => {
  const archive = tar([{}]);
  assert.throws(() => inspectTar(archive, { maxOutputLength: 1024 }));
  assert.equal(inspectTar(archive).entries.length, 1);
});
