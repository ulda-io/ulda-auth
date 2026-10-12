import { test } from "node:test";
import assert from "node:assert/strict";
import { Ulda, SocketIoTransport } from "../src/index.js";
import { fixture } from "./server.js";
import { newOrigin, advance } from "../src/core.js";
import { contentCredentials, newContentSecret, newToken, seal } from "../src/crypto.js";
import { b64 } from "../src/values.js";
import { emptyPacket, readPacket, writePacket, deletionProof, deletePacket } from "../src/protocol.js";

async function setup(t, timeout = 1500) {
  const server = await fixture();
  const transport = new SocketIoTransport(server.url, { allowInsecureLocalhost: true, timeout });
  const traces = [];
  transport.on("trace", (record) => traces.push(record));
  t.after(async () => { transport.close(); await server.close(); });
  return { server, transport, traces };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Trace not received");
}
function assertOnlyMetadata(traces) {
  const allowed = new Set(["time", "phase", "event", "request", "durationMs", "code", "ok", "ids", "items", "updated", "deleted", "volatile", "id", "witnessBytes", "payloadBytes"]);
  const visit = value => {
    if (value && typeof value === "object") {
      assert.ok(Object.isFrozen(value));
      if (!Array.isArray(value)) for (const key of Object.keys(value)) assert.ok(allowed.has(key), key);
      Object.values(value).forEach(visit);
    }
  };
  traces.forEach(visit);
}

test("SDK trace correlates actual requests/ACKs and excludes names, passwords, plaintext and wire values", async (t) => {
  const { server, transport, traces } = await setup(t);
  // A subscriber can neither alter trace records for later observers nor interrupt SDK work.
  transport.on("trace", record => { record.phase = "mutated"; });
  transport.on("trace", record => { record.items?.push({ id: "999" }); });
  const ulda = new Ulda(server.url, { transport });
  t.after(() => ulda.close());
  const password = "trace-private-password-marker";
  const masterId = await ulda.register(password);
  await ulda.add("trace-private-content-name", { secret: "trace-private-payload-marker" });
  await ulda.update("trace-private-content-name", { secret: "trace-private-updated-marker" });
  await ulda.refresh();
  assert.equal(traces.some(x => x.phase === "push"), false);
  await ulda.close();
  const sends = traces.filter(x => x.phase === "send");
  assert.equal(sends.length, server.frames.length);
  assert.deepEqual(sends.map(x => x.event), server.frames.map(x => `ulda:${x.action}`));
  assert.equal(new Set(sends.map(x => x.request)).size, sends.length);
  for (const sent of sends) {
    const ack = traces.find(x => x.phase === "ack" && x.request === sent.request);
    assert.equal(ack?.event, sent.event);
    assert.equal(ack.ok, true);
    assert.ok(ack.durationMs >= 0);
  }
  assert.deepEqual(traces.find(x => x.phase === "ack" && x.event === "ulda:create").ids, [masterId]);
  const summary = traces.find(x => x.phase === "ack" && x.event === "ulda:read").items[0];
  assert.equal(summary.id, masterId);
  assert.ok(summary.payloadBytes > 0 && summary.witnessBytes > 0);
  const text = JSON.stringify(traces);
  for (const secret of [password, "trace-private-content-name", "trace-private-payload-marker", "trace-private-updated-marker"])
    assert.equal(text.includes(secret), false);
  for (const frame of server.frames) {
    for (const item of Array.isArray(frame.body) ? frame.body : []) {
      for (const key of ["payload", "witness"]) if (item[key]) assert.equal(text.includes(b64(item[key])), false);
      if (item.payload) assert.equal(text.includes(Buffer.from(item.payload).toString("hex")), false);
    }
  }
  assert.ok(traces.some(x => x.event === "closed"));
  assertOnlyMetadata(traces);
});

test("trace hides origin/key/token, reports byte sizes and deletion notifications without observer mutation", async (t) => {
  const { server, transport, traces } = await setup(t);
  await transport.start();
  const key = newContentSecret(), token = newToken(), origin = newOrigin("X");
  const credentials = await contentCredentials(key);
  const sealed = await seal(credentials, token, origin, { secret: "hidden-payload" });
  const [id] = await transport.send(writePacket("create", [{ sealed }]));
  const unsubscribe = transport.on("trace", record => { if (record.ids) record.ids[0] = "999"; });
  await transport.send(readPacket([id]));
  assert.equal(server.frames.at(-1).body[0], id);
  unsubscribe();
  const next = advance(origin);
  const writer = new SocketIoTransport(server.url, { allowInsecureLocalhost: true });
  t.after(() => writer.close());
  await writer.start();
  await transport.send(writePacket("update", [{ id, sealed: await seal(credentials, token, next, { secret: "hidden-next" }) }]));
  await writer.send(deletePacket([await deletionProof(id, next)]));
  await until(() => traces.some(x => x.deleted?.includes(id)));
  const text = JSON.stringify(traces);
  for (const secret of [key, token, b64(origin), b64(next), "hidden-payload", "hidden-next"])
    assert.equal(text.includes(secret), false);
  const write = traces.find(x => x.phase === "send" && x.event === "ulda:create").items[0];
  const body = server.frames.find(x => x.action === "create").body[0];
  assert.equal(write.payloadBytes, body.payload.byteLength);
  assert.equal(write.witnessBytes, body.witness.byteLength);
  assertOnlyMetadata(traces);
});

test("trace distinguishes error ACKs, invalid notifications and unknown writes; never echoes server errors", async (t) => {
  const { server, transport, traces } = await setup(t, 200);
  await transport.start();
  server.faults.push({ action: "read", error: "reflected-password-plaintext-marker" });
  await assert.rejects(transport.send(readPacket(["101"])), { code: "SERVER_ERROR" });
  assert.equal(traces.at(-1).phase, "ack");
  assert.equal(traces.at(-1).code, "SERVER_ERROR");
  server.faults.push({ action: "hello", response: () => ({ ok: true, secret: "reflected-private-payload" }) });
  await assert.rejects(transport.send(emptyPacket("hello")), { code: "INVALID_PACKET" });
  assert.equal(traces.at(-1).phase, "ack");
  server.sendChanged({ updated: [{ payload: "reflected-private-payload" }] });
  await until(() => traces.some(x => x.phase === "push" && x.code === "INVALID_PACKET"));
  const sealed = await seal(await contentCredentials(newContentSecret()), newToken(), newOrigin("X"), {});
  server.faults.push({ action: "create", dropAck: true });
  await assert.rejects(transport.send(writePacket("create", [{ sealed }]), { volatile: true }), { code: "UNKNOWN_OUTCOME" });
  const failure = traces.at(-1);
  assert.equal(failure.phase, "failure");
  assert.equal(failure.code, "UNKNOWN_OUTCOME");
  assert.equal(traces.find(x => x.phase === "send" && x.request === failure.request).volatile, true);
  assert.equal(traces.some(x => x.phase === "ack" && x.request === failure.request), false);
  server.faults.push({ action: "read", dropRequest: true });
  const pending = transport.send(readPacket(["101"]));
  transport.disconnect();
  await assert.rejects(pending, { code: "OFFLINE" });
  assert.ok(traces.some(x => x.event === "disconnect"));
  assert.equal(JSON.stringify(traces).includes("reflected-"), false);
  assertOnlyMetadata(traces);
});
