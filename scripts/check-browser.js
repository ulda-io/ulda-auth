import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { tarEntries } from './tar-entries.js';
import { fixture } from '../tests/server.js';
// Fresh isolated headless profiles. Never attaches to the user's browser.
let http, backend, activeBrowser;
try {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const archive = await readFile(new URL('../.local/release/' + pkg.name + '-' + pkg.version + '.tgz', import.meta.url));
  const bundle = tarEntries(archive).find(e => e.path === 'package/dist/ulda-library.js')?.bytes;
  if (!bundle) throw new Error('Missing packed browser entry.');
  backend = await fixture();
  http = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', request.url === '/sdk.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/sdk.js' ? bundle : '<!doctype html><title>Synthetic SDK package check</title>');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const results = [];
  for (const channel of ['chrome', 'msedge']) {
    activeBrowser = await chromium.launch({ channel, headless: true, chromiumSandbox: true });
    const page = await activeBrowser.newPage();
    await page.goto('http://127.0.0.1:' + http.address().port);
    const passed = await page.evaluate(async endpoint => {
      const { Ulda } = await import('/sdk.js');
      const a = new Ulda(endpoint, { allowInsecureLocalhost: true });
      const b = new Ulda(endpoint, { allowInsecureLocalhost: true });
      try {
        const password = crypto.randomUUID();
        const id = await a.register(password);
        await a.add('note', { n: 1 });
        await a.add('stream', { n: 0 }, 'S');
        await b.connect(id, password);
        const changed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { off(); reject(new Error('Synthetic update timeout')); }, 10000);
          const off = b.on('change', () => { if (b.value('note').n === 2) { clearTimeout(timer); off(); resolve(); } });
        });
        await a.update('note', { n: 2 }); await changed;
        await Promise.all([1, 2, 3].map(n => a.update('stream', { n })));
        await b.refresh();
        if (b.value('stream').n !== 3) throw new Error('Synthetic data mismatch.');
        await a.delete('stream'); await a.superDelete();
        return a.status === 'closed';
      } finally { await a.close(); await b.close(); }
    }, backend.url);
    if (!passed || backend.records.size !== 0) throw new Error('Browser lifecycle or cleanup failed.');
    results.push({ channel, version: activeBrowser.version(), passed: true });
    await activeBrowser.close(); activeBrowser = undefined;
    backend.frames.length = 0; backend.commits.length = 0;
  }
  const report = { checkedAt: new Date().toISOString(), sha256: createHash('sha256').update(archive).digest('hex'),
    target: 'packed browser entry, isolated headless browsers, in-memory loopback fixture',
    results, limits: ['not a full browser compatibility/load matrix', 'no real user browser profile accessed'] };
  await writeFile('.local/release/browser-check.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error('Packed browser acceptance failed. Install Chrome/Edge and rerun; private diagnostics suppressed.');
  process.exitCode = 1;
} finally {
  if (activeBrowser) await activeBrowser.close();
  if (http) await new Promise(resolve => http.close(resolve));
  if (backend) await backend.close();
}
