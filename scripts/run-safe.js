import { spawn } from 'node:child_process';
// Small repository checks must not leak assertion values through uncaught errors.
const tasks = new Map([['scripts/check-bundle.js', 'bundle'], ['examples/demo.js', 'demo']]);
const script = process.argv[2], label = tasks.get(script);
if (!label) { console.error('Unknown repository check.'); process.exitCode = 1; }
else {
  const env = { ...process.env, NODE_OPTIONS: '', DEBUG: '' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_V8_COVERAGE;
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore'], env });
  child.on('error', () => { console.error('FAIL: ' + label + ' could not start.'); process.exitCode = 1; });
  child.on('exit', code => { console.log((code === 0 ? 'PASS: ' : 'FAIL: ') + label + ' check; private diagnostics suppressed.'); process.exitCode = code === 0 ? 0 : 1; });
}
