import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from '../tests/server.js';
import { tarEntries } from './tar-entries.js';
const root = resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const childEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DEBUG: '' };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.NODE_V8_COVERAGE;
function run(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    child.stdout.on('data', data => { size += data.length; if (size <= 4 * 1024 * 1024) chunks.push(data); else child.kill(); });
    child.stderr.on('data', () => {}); // Errors can include environment data; never reflect them.
    child.on('error', () => reject(new Error('Package subprocess could not start.')));
    child.on('exit', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error('Package subprocess failed.')));
  });
}
const externalEndpoint = process.argv[2];
if (externalEndpoint) {
 try {
  const url = new URL(externalEndpoint);
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid endpoint.');
 } catch {
  console.error('Package acceptance requires a valid credential-free loopback test endpoint.');
  process.exit(1);
 }
}
let temporary, server, phase = 'build';
try {
  await run(['scripts/build.js']);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'ulda-auth');
  assert.equal(pkg.dependencies['ulda-core'], '1.0.1');
  assert.equal(Object.values(pkg.dependencies).some(x => /^(?:file:|link:|workspace:)/.test(x)), false);
  const destination = join(root, '.local', 'release');
  await mkdir(destination, { recursive: true });
  phase = 'pack';
  const [packed] = JSON.parse(await run([npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination]));
  const archive = join(destination, packed.filename);
  const archiveBytes = await readFile(archive);
  const entries = tarEntries(archiveBytes);
  const paths = new Set(entries.map(e => e.path.replace(/^package\//, '')));
  phase = 'package allowlist';
  const allowed = new Set(['package.json', ...pkg.files.filter(p => !p.includes('*')),
    ...(await readdir(join(root, 'src'))).filter(f => f.endsWith('.js')).map(f => 'src/' + f)]);
  assert.deepEqual([...paths].sort(), [...allowed].sort(), 'Tarball must contain only the explicit release files.');
  phase = 'documentation links';
  for (const entry of entries) {
    const path = entry.path.replace(/^package\//, '');
    if (!path.endsWith('.md')) continue;
    for (const match of entry.bytes.toString().matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const normalized = relative('.', resolve(dirname(path), target)).replaceAll('\\', '/');
      assert.ok(paths.has(normalized), 'Packaged Markdown link must stay within the package.');
    }
  }
  phase = 'isolated install';
  temporary = await mkdtemp(join(tmpdir(), 'ulda-package-'));
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'synthetic-release-consumer', version: '0.0.0', private: true, type: 'module' }));
  await run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', archive], temporary);
  phase = 'consumer lifecycle';
  if (!externalEndpoint) server = await fixture();
  await writeFile(join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { Ulda, UldaError, SocketIoTransport } from 'ulda-auth';
import { Ulda as BrowserUlda } from 'ulda-auth/browser';
assert.equal(typeof UldaError, 'function'); assert.equal(typeof SocketIoTransport, 'function');
for (const entry of ['ulda-auth/src/crypto.js', 'ulda-auth/tests/server.js'])
  await assert.rejects(import(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const endpoint = ${JSON.stringify(externalEndpoint ?? server.url)}, password = crypto.randomUUID();
const options = { allowInsecureLocalhost: true };
const a = new Ulda(endpoint, options), b = new BrowserUlda(endpoint, options);
try {
 const master = await a.register(password);
 await a.add('note', { value: 1 });
 await a.add('stream', { count: 0 }, 'S');
 await b.connect(master, password);
 const changed = new Promise((resolve, reject) => {
   const timer = setTimeout(() => { off(); reject(new Error('Synthetic change timeout')); }, 10000);
   const off = b.on('change', () => { if (b.value('note').value === 2) { clearTimeout(timer); off(); resolve(); } });
 });
 await a.update('note', { value: 2 }); await changed;
 await Promise.all([1,2,3].map(count => a.update('stream', { count })));
 await b.refresh(); assert.equal(b.value('stream').count, 3);
 if (!${Boolean(externalEndpoint)}) { await a.recoverContent('note'); await b.refresh(); assert.equal(b.value('note').value, 2); }
 await a.delete('stream');
 await a.superDelete();
 assert.equal(a.status, 'closed');
} finally { await a.close(); await b.close(); }
`);
  await run(['consumer.mjs'], temporary);
  phase = 'installed declarations';
  const ts = (await readFile(join(root, 'tests/types/consumer.ts'), 'utf8'));
  await writeFile(join(temporary, 'types.ts'), ts);
  await run([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.ts'], temporary);
  const receipt = { name: pkg.name, version: pkg.version, filename: packed.filename, files: paths.size,
    packedBytes: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    target: externalEndpoint ? 'explicit loopback backend' : 'in-memory fixture',
    node: process.version, checkedAt: new Date().toISOString(),
    checks: ['allowlist', 'documentation links', 'clean install from registry dependencies', 'Node ESM',
      'standalone browser ESM in Node', externalEndpoint ? 'two clients / Changed / X / S / delete' : 'two clients / Changed / X / S / recovery / delete', 'private export boundary', 'installed TypeScript'],
    limits: [externalEndpoint ? 'explicit backend smoke, not the full fault/load matrix' : 'in-memory loopback fixture, not PostgreSQL or a real browser in this check', 'not an independent security audit'] };
  await writeFile(join(destination, externalEndpoint ? 'package-check-server.json' : 'package-check.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch {
  console.error('Package acceptance failed at: ' + phase + '. Raw child output suppressed.');
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (temporary) {
    const parent = resolve(tmpdir()), target = resolve(temporary);
    if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('ulda-package-'))
      throw new Error('Refusing cleanup outside the generated temporary directory.');
    await rm(target, { recursive: true, force: true });
  }
}
