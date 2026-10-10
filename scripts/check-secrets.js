import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectTar, ARCHIVE_BYTES } from './tar-entries.js';
const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...args],
  { cwd: root, maxBuffer: 64 * 1024 * 1024 });
import { rules } from './secret-patterns.js';
const allow = JSON.parse(readFileSync(new URL('./secret-scan-allowlist.json', import.meta.url), 'utf8'));
const findings = [], seen = new Set();
let checked = 0, archives = 0;
const objectCounts = { blob: 0, commit: 0, tag: 0 };
function scan(bytes, location, path = location, budget = { remaining: ARCHIVE_BYTES }, depth = 0) {
  checked++;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    archives++;
    if (depth >= 4) throw new Error('Archive nesting limit.');
    const archive = inspectTar(bytes, { maxOutputLength: budget.remaining });
    budget.remaining -= archive.expandedBytes;
    // Metadata has NUL separators; normalize those separators only for scanning.
    for (const [index, header] of archive.headers.entries())
      scan(Buffer.from(header.toString('utf8').replaceAll('\0', '\n')), location + '!header-' + index, path + '!header-' + index, budget, depth + 1);
    for (const entry of archive.entries)
      scan(entry.bytes, location + '!' + entry.path, path + '!' + entry.path, budget, depth + 1);
    return;
  }
  if (bytes.includes(0)) { findings.push({ location, rule: 'uninspected-binary' }); return; }
  const source = bytes.toString('utf8');
  for (const [rule, regex] of rules) for (const match of source.matchAll(regex)) {
    const fingerprint = createHash('sha256').update(match[0]).digest('hex');
    const item = { location, rule, line: source.slice(0, match.index).split('\n').length, fingerprint };
    if (allow.some(a => a.rule === rule && a.fingerprint === fingerprint && a.files.includes(path))) continue;
    findings.push(item);
  }
}
try {
  // All local object records, including deleted paths, other refs and unreachable history.
  const paths = new Map(git('rev-list', '--objects', '--all', '--reflog').toString().trim().split('\n').map(line => [line.slice(0, 40), line.slice(41)]));
  const objects = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)').toString().trim().split('\n');
  for (const row of objects) {
    const [sha, type] = row.trim().split(' ');
    if (!['blob', 'commit', 'tag'].includes(type)) continue;
    objectCounts[type]++;
    scan(git('cat-file', type, sha), 'git:' + sha, paths.get(sha));
  }
  const names = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);
  for (const name of names) {
    if (seen.has(name) || !existsSync(resolve(root, name))) continue;
    seen.add(name);
    if (/(^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials|[^/]+\.(?:pem|p12|pfx|key))$/i.test(name) && !name.endsWith('.example'))
      findings.push({ location: name, rule: 'sensitive-filename' });
    scan(readFileSync(resolve(root, name)), 'working:' + name, name);
  }
  console.log(JSON.stringify({ checked, archives, objectCounts, reviewedExceptions: allow.length, findings: findings.length, details: findings.map(({ fingerprint, ...safe }) => safe) }, null, 2));
  if (findings.length) process.exitCode = 1;
} catch {
  console.error('Secret scan did not complete; no sensitive error details were printed.');
  process.exitCode = 1;
}
