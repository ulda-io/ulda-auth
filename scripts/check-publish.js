import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tarEntries } from './tar-entries.js';
const root = resolve(import.meta.dirname, '..');
try {
  // This command has no real-publish mode. Never forward caller arguments to npm.
  assert.equal(process.argv.length, 2);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'ulda-auth');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.notEqual(pkg.private, true);
  assert.deepEqual(pkg.publishConfig, { registry: 'https://registry.npmjs.org/', access: 'public', tag: 'latest' });
  assert.equal(pkg.repository.url, 'git+https://github.com/ulda-io/ulda-auth.git');
  const filename = pkg.name + '-' + pkg.version + '.tgz';
  const folder = join(root, '.local', 'release');
  const archive = readFileSync(join(folder, filename));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const accepted = JSON.parse(readFileSync(join(folder, 'package-check.json'), 'utf8'));
  assert.equal(accepted.filename, filename);
  assert.equal(accepted.sha256, sha256);
  const packed = JSON.parse(tarEntries(archive).find(e => e.path === 'package/package.json').bytes);
  assert.deepEqual(packed, pkg);
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const childEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DEBUG: '' };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_V8_COVERAGE;
  // npm 11 rejects already published versions even in dry-run. This check
  // validates packaging only; --force bypasses that guard, never --dry-run.
  // The real publisher must not inherit this flag or bypass version uniqueness.
  const result = spawnSync(process.execPath, [npm, 'publish', join(folder, filename),
    '--dry-run', '--ignore-scripts', '--force', '--json', '--access=public', '--tag=latest',
    '--registry=https://registry.npmjs.org/'],
    { cwd: root, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  // npm 10 returns the summary directly; newer npm 11 keys it by package name.
  // Accept exactly one package in the keyed form, then verify the same identity
  // and archive integrity in either format.
  const keyed = Object.hasOwn(output, pkg.name);
  if (keyed) assert.deepEqual(Object.keys(output), [pkg.name]);
  const summary = keyed ? output[pkg.name] : output;
  assert.equal(summary.name, pkg.name);
  assert.equal(summary.version, pkg.version);
  assert.equal(summary.integrity, 'sha512-' + createHash('sha512').update(archive).digest('base64'));
  const receipt = { name: pkg.name, version: pkg.version, filename, sha256,
    integrity: summary.integrity, dryRun: true, published: false,
    registry: pkg.publishConfig.registry, tag: pkg.publishConfig.tag,
    checkedAt: new Date().toISOString(),
    limits: ['does not establish npm login, package-name ownership, version availability or publish permission'] };
  writeFileSync(join(folder, 'publish-check.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch {
  console.error('Publish dry-run failed. No publication was attempted; private subprocess diagnostics suppressed.');
  process.exitCode = 1;
}
