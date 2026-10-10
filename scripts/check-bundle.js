import assert from "node:assert/strict";
import { Ulda } from "../dist/ulda-library.js";
import { fixture } from "../tests/server.js";

// Exercises the browser bundle using Node 22's native WebSocket and Web Crypto.
// This is not a claim that a real browser UI has been tested.
const server = await fixture();
const sdk = new Ulda(server.url, { allowInsecureLocalhost: true });
try {
  const resourceId = await sdk.register("synthetic-bundle-test-password");
  assert.match(resourceId, /^[1-9][0-9]*$/);
  assert.equal(sdk.status, "open");
  await sdk.add("example", { value: 1 });
  await sdk.data.example.value.update(2);
  assert.equal(sdk.data.example.value.get(), 2);
  for (let i = 0; i < 7; i++) await sdk.add(`batch-${i}`, { value: i });
  await sdk.refresh(); // Eight resources exceed the default parser's 10 attachments.
  assert.equal(Object.keys(sdk.snapshot()).length, 8);
  assert.equal(sdk.value('batch-6').value, 6);
  const recovery = await sdk.recoverContent('example');
  assert.notEqual(recovery.id, recovery.previousId);
  assert.ok(server.records.has(recovery.previousId));
  assert.equal(sdk.value('example').value, 2);
  const restored = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bundle reconnect timed out')), 10000);
    const off = sdk.on('reconnect', event => {
      if (event.phase === 'restored' || event.phase === 'stopped') {
        clearTimeout(timer); off();
        event.phase === 'restored' ? resolve() : reject(new Error(event.code));
      }
    });
  });
  const start = server.frames.length;
  server.io.sockets.sockets.get(server.frames[0].socket).conn.close();
  await restored;
  assert.equal(sdk.status, 'open');
  assert.equal(Object.keys(sdk.snapshot()).length, 8);
  assert.equal(server.frames.slice(start).some(frame => ['create', 'update', 'delete'].includes(frame.action)), false);
  console.log(
    "PASS: browser bundle, eight resources, explicit content recovery and automatic reconnect without write replay.",
  );
} finally {
  await sdk.close();
  await server.close();
}
