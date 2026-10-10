// Only result metadata leaves the test runner. Never serialize names, errors,
// assertions, stdout/stderr, diagnostic messages, stack traces or test values.
import { basename } from 'node:path';
export default async function* safeReporter(source) {
  let passed = 0, failed = 0, skipped = 0;
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const file = basename(typeof data.file === 'string' ? data.file : '');
    const label = /^[a-z0-9._-]+\.(?:m?js|ts)$/i.test(file) ? file : 'test';
    const line = Number.isSafeInteger(data.line) ? data.line : 0;
    if (data.skip || data.todo) skipped++;
    else if (type === 'test:fail') failed++;
    else passed++;
    yield `${type === 'test:fail' ? 'FAIL' : 'PASS'} ${label}:${line}\n`;
  }
  yield `Results: passed=${passed} failed=${failed} skipped/todo=${skipped}. Private diagnostics suppressed.\n`;
}
