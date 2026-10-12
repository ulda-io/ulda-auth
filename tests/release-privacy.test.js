import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { UldaError } from '../src/index.js';

test('public errors reject unknown codes without coercing supplied values', () => {
  const known = new UldaError('OFFLINE');
  assert.equal(known.code, 'OFFLINE');
  assert.equal(known.message, 'Transport is not ready.');

  let coercions = 0;
  const untrusted = { [Symbol.toPrimitive]() { coercions++; throw new Error('Must not coerce error input.'); } };
  for (const input of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'unknown',
    '', null, undefined, 42, Symbol('unknown'), untrusted]) {
    const error = new UldaError(input);
    assert.equal(error.name, 'UldaError');
    assert.equal(error.code, 'SERVER_ERROR');
    assert.equal(error.message, 'Server rejected the request.');
  }
  assert.equal(coercions, 0);
});

test('default reporter hides failing assertions, test names, stdout, stderr and diagnostic values', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ulda-reporter-'));
  try {
    const marker = 'SYNTHETIC_PRIVATE_' + crypto.randomUUID();
    const code = `import {test} from 'node:test'; import assert from 'node:assert/strict';
      test(${JSON.stringify(marker)}, t => {
        console.log(${JSON.stringify(marker)});
        console.error(${JSON.stringify(marker)});
        t.diagnostic(${JSON.stringify(marker)});
        assert.equal(${JSON.stringify(marker)}, 'different', ${JSON.stringify(marker)});
      });`;
    const file = join(folder, 'synthetic.test.mjs');
    await writeFile(file, code);
    const childEnv = { ...process.env, NODE_OPTIONS: '' };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=' +
      pathToFileURL(resolve('scripts/safe-test-reporter.js')).href, file], { encoding: 'utf8', env: childEnv });
    assert.equal(result.status, 1, 'Intentional failure must retain exit status.');
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(marker), false, 'Private marker escaped reporter.');
    assert.equal(output.includes('FAIL synthetic.test.mjs'), true);
    assert.equal(output.includes('failed=1'), true);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('package check does not echo a malformed endpoint or credentials', () => {
  const marker = 'SYNTHETIC_PRIVATE_' + crypto.randomUUID();
  const result = spawnSync(process.execPath, ['scripts/check-package.js', marker], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(marker), false);
});
