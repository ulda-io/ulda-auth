import assert from "node:assert/strict";
import { Ulda } from "../dist/ulda-library.js";
import { fixture } from "../tests/server.js";

// Exercises the browser bundle using Node 22's native WebSocket and Web Crypto.
// This is not a claim that a real browser UI has been tested.
const server = await fixture();
const ulda = new Ulda(server.url, { allowInsecureLocalhost: true });
try {
  const resourceId = await ulda.register("synthetic-bundle-test-password");
  assert.match(resourceId, /^[1-9][0-9]*$/);
  assert.equal(ulda.status, "open");
  await ulda.add("example", { value: 1 });
  await ulda.data.example.value.update(2);
  assert.equal(ulda.data.example.value.get(), 2);
  for (let i = 0; i < 7; i++) await ulda.add(`batch-${i}`, { value: i });
  await ulda.refresh(); // Eight resources exceed the default parser's 10 attachments.
  assert.equal(Object.keys(ulda.snapshot()).length, 8);
  assert.equal(ulda.value('batch-6').value, 6);
  const recovery = await ulda.recoverContent('example');
  assert.notEqual(recovery.id, recovery.previousId);
  assert.ok(server.records.has(recovery.previousId));
  assert.equal(ulda.value('example').value, 2);
  const restored = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bundle reconnect timed out')), 10000);
    const off = ulda.on('reconnect', event => {
      if (event.phase === 'restored' || event.phase === 'stopped') {
        clearTimeout(timer); off();
        event.phase === 'restored' ? resolve() : reject(new Error(event.code));
      }
    });
  });
  const start = server.frames.length;
  server.io.sockets.sockets.get(server.frames[0].socket).conn.close();
  await restored;
  assert.equal(ulda.status, 'open');
  assert.equal(Object.keys(ulda.snapshot()).length, 8);
  assert.equal(server.frames.slice(start).some(frame => ['create', 'update', 'delete'].includes(frame.action)), false);
  console.log(
    "PASS: browser bundle, eight resources, explicit content recovery and automatic reconnect without write replay.",
  );
} finally {
  await ulda.close();
  await server.close();
}
