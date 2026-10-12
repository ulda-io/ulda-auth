import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

function fixture(t, { invalidIntegrity = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ulda-publish-check-'));
  t.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('ulda-publish-check-'));
    rmSync(folder, { recursive: true, force: true });
  });
  mkdirSync(join(folder, 'scripts'));
  mkdirSync(join(folder, '.local/release'), { recursive: true });
  for (const name of ['check-publish.js', 'tar-entries.js'])
    copyFileSync(resolve('scripts', name), join(folder, 'scripts', name));
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const manifest = Buffer.from(JSON.stringify(pkg));
  writeFileSync(join(folder, 'package.json'), manifest);
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 100);
  header.write(manifest.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const archive = gzipSync(Buffer.concat([header, manifest,
    Buffer.alloc((512 - manifest.length % 512) % 512), Buffer.alloc(1024)]));
  const filename = pkg.name + '-' + pkg.version + '.tgz';
  writeFileSync(join(folder, '.local/release', filename), archive);
  writeFileSync(join(folder, '.local/release/package-check.json'), JSON.stringify({ filename,
    sha256: createHash('sha256').update(archive).digest('hex') }));
  const summary = { name: pkg.name, version: pkg.version,
    integrity: invalidIntegrity ? 'invalid' : 'sha512-' + createHash('sha512').update(archive).digest('base64') };
  const marker = 'SYNTHETIC_PRIVATE_' + crypto.randomUUID();
  const invocationFile = join(folder, 'invocation.json');
  const fakeNpm = join(folder, 'synthetic-npm.cjs');
  writeFileSync(fakeNpm, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify(args));
    // Model npm 11's existing-version guard. Force is safe only with dry-run.
    if (!args.includes('--dry-run') || !args.includes('--force')) process.exit(1);
    console.error(${JSON.stringify(marker)});
    console.log(${JSON.stringify(JSON.stringify({ [pkg.name]: summary }))});
  `);
  const env = { ...process.env, npm_execpath: fakeNpm, NODE_OPTIONS: '', NODE_PATH: '', DEBUG: '' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  return { folder, marker, invocationFile, filename,
    run: (...args) => spawnSync(process.execPath, ['scripts/check-publish.js', ...args],
      { cwd: folder, env, encoding: 'utf8', timeout: 15000 }) };
}

test('publish rehearsal accepts an existing version only as an explicit no-script dry-run', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.invocationFile, 'utf8')), [
    'publish', join(f.folder, '.local/release', f.filename), '--dry-run', '--ignore-scripts',
    '--force', '--json', '--access=public', '--tag=latest', '--registry=https://registry.npmjs.org/',
  ]);
  const receipt = JSON.parse(readFileSync(join(f.folder, '.local/release/publish-check.json'), 'utf8'));
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.published, false);
  assert.equal((result.stdout + result.stderr).includes(f.marker), false);
});

test('publish rehearsal still rejects a mismatched archive integrity without exposing child diagnostics', t => {
  const f = fixture(t, { invalidIntegrity: true }), result = f.run();
  assert.equal(result.status, 1);
  assert.equal(existsSync(f.invocationFile), true);
  assert.equal(existsSync(join(f.folder, '.local/release/publish-check.json')), false);
  assert.equal((result.stdout + result.stderr).includes(f.marker), false);
});

test('publish rehearsal rejects arguments that could disable dry-run before starting npm', t => {
  const f = fixture(t), result = f.run('--dry-run=false');
  assert.equal(result.status, 1);
  assert.equal(existsSync(f.invocationFile), false);
});
