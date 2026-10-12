import { test } from "node:test";
import assert from "node:assert/strict";
import { Ulda } from "../src/index.js";
import { fixture } from "./server.js";
import { parseWitness } from "../src/core.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await wait(10);
  }
  assert.fail("Condition timed out");
}
async function setup(t, timeout = 1500) {
  const server = await fixture();
  const clients = [];
  const client = () => {
    const ulda = new Ulda(server.url, { timeout, allowInsecureLocalhost: true });
    clients.push(ulda);
    return ulda;
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    await server.close();
  });
  const ulda = client();
  const password = "synthetic-master-password-not-real";
  const masterId = await ulda.register(password);
  return { server, ulda, client, masterId, password };
}

test("register/connect/add/proxy update/delete/reopen preserve encrypted data and chain state", async (t) => {
  const { server, ulda, client, masterId, password } = await setup(t);
  assert.equal(typeof masterId, "string");
  assert.equal(parseWitness(server.records.get(masterId).witness).mode, "X");
  const result = await ulda.add("private-content-name", {
    title: "private-original-text",
    flag: false,
    list: [1, 2, 3],
    update: "collision",
  });
  assert.equal(result.ok, true);
  await ulda.data["private-content-name"].title.update("private-next-text");
  await ulda.data["private-content-name"].list[1].delete();
  assert.deepEqual(
    Array.from(ulda.data["private-content-name"].list.get()),
    [1, 3],
  );
  assert.equal(ulda.data["private-content-name"].flag.get(), false);
  assert.equal(
    ulda.data["private-content-name"].field("update").get(),
    "collision",
  );
  const titleRef = ulda.data["private-content-name"].title;
  assert.equal(await titleRef, titleRef); // references are not thenables
  const traffic = JSON.stringify(server.frames);
  for (const secret of [
    password,
    "private-content-name",
    "private-original-text",
    "private-next-text",
  ]) {
    assert.equal(traffic.includes(secret), false);
    for (const record of server.records.values())
      assert.equal(
        Buffer.from(record.payload).includes(Buffer.from(secret)),
        false,
      );
  }
  assert.equal(JSON.stringify(ulda), "{}");
  const previousRef = ulda.data["private-content-name"].title;
  await ulda.close();
  assert.throws(() => previousRef.get(), { code: "STALE_REFERENCE" });
  const other = client();
  await other.connect(masterId, password);
  assert.equal(
    other.data["private-content-name"].title.get(),
    "private-next-text",
  );
  await other.data["private-content-name"].title.update("after-new-instance");
});

test("read automatically subscribes both clients; Changed master discovers new content", async (t) => {
  const { server, ulda, client, masterId, password } = await setup(t);
  const other = client();
  await other.connect(masterId, password);
  await ulda.add("shared", { value: 1 });
  await until(() => other.snapshot().shared?.value === 1);
  await ulda.data.shared.value.update(2);
  await until(() => other.snapshot().shared.value === 2);
  assert.equal(server.watchers.get(masterId).size, 2);
  await other.close();
  await until(() => server.watchers.get(masterId).size === 1);
});

test("X serializes calls; timeout after commit blocks writes until safe refresh", async (t) => {
  const { server, ulda } = await setup(t, 200);
  await ulda.add("item", { value: 0 });
  const contentId = [...server.records.keys()].at(-1);
  server.faults.push({ action: "update", dropAck: true, dropChanged: true });
  const a = ulda.data.item.value.update(1);
  const b = ulda.data.item.value.update(2);
  const results = await Promise.allSettled([a, b]);
  assert.equal(results[0].reason.code, "UNKNOWN_OUTCOME");
  assert.equal(results[1].reason.code, "NEEDS_RESYNC");
  assert.equal(parseWitness(server.records.get(contentId).witness).age, 2);
  assert.throws(() => ulda.data.item.value.update(3), { code: "NEEDS_RESYNC" });
  await ulda.refresh();
  await ulda.data.item.value.update(3);
  assert.equal(ulda.data.item.value.get(), 3);
});

test("S sends at most N-1 ages ahead without ACK; missing step can be skipped", async (t) => {
  const { server, ulda } = await setup(t, 300);
  await ulda.add("stream", { value: 0 }, "S");
  const start = server.frames.length;
  server.faults.push({ action: "update", dropRequest: true });
  for (let i = 0; i < 3; i++)
    server.faults.push({ action: "update", ackDelay: 120, dropChanged: true });
  const promises = Array.from({ length: 5 }, (_, i) =>
    ulda.data.stream.value.update(i + 1),
  );
  const settled = Promise.allSettled(promises);
  await wait(70);
  const writes = server.frames
    .slice(start)
    .filter((x) => x.action === "update");
  assert.equal(writes.length, 4);
  assert.deepEqual(
    writes.map((x) => parseWitness(x.body[0].witness).age),
    [2, 3, 4, 5],
  );
  const results = await settled;
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason.code, "UNKNOWN_OUTCOME");
  assert.equal(
    results.slice(1).every((x) => x.status === "fulfilled"),
    true,
  );
  assert.equal(ulda.data.stream.value.get(), 5);
});

test("atomic content+master Update rejects both on conflict and reuses created content ID", async (t) => {
  const { server, ulda } = await setup(t);
  const initialMaster = server.records.values().next().value;
  server.faults.push({ action: "update", error: "conflict" });
  await assert.rejects(ulda.add("new", { secret: 1 }), { code: "CONFLICT" });
  assert.equal(server.records.size, 2);
  assert.equal(
    server.records.get(initialMaster.id).payload,
    initialMaster.payload,
  );
  const orphanId = [...server.records.keys()].at(-1);
  assert.equal(parseWitness(server.records.get(orphanId).witness).age, 0);
  await ulda.add("new", { secret: 1 });
  assert.equal(server.records.size, 2);
  assert.equal(ulda.data.new.secret.get(), 1);
});

test("corrupted ciphertext and rollback never replace public data", async (t) => {
  const { server, ulda } = await setup(t);
  await ulda.add("safe", { value: 1 });
  const record = structuredClone([...server.records.values()].at(-1));
  const bytes = record.payload.slice();
  bytes[bytes.length - 1] ^= 1;
  server.sendChanged({ updated: [{ ...record, payload: bytes }], deleted: [] });
  await until(() => ulda.status === "needsResync");
  assert.equal(ulda.data.safe.value.get(), 1);
  await ulda.refresh();
  await ulda.data.safe.value.update(2);
  server.faults.push({
    action: "read",
    match: (body) => body.includes(record.id),
    response: () => ({ ok: true, data: [record] }),
  });
  await assert.rejects(ulda.refresh(), { code: "ROLLBACK" });
  assert.equal(ulda.data.safe.value.get(), 2);
});

test("disconnect has no hidden offline replay; reconnect reads and subscribes again", async (t) => {
  const { server, ulda } = await setup(t);
  await ulda.add("item", { value: 1 });
  for (const socket of server.io.sockets.sockets.values())
    socket.disconnect(true);
  await until(() => ulda.status === "disconnected");
  const before = server.frames.length;
  assert.throws(() => ulda.data.item.value.update(2), { code: "NEEDS_RESYNC" });
  await ulda.reconnect();
  assert.equal(ulda.status, "open");
  assert.equal(
    server.frames.slice(before).some((x) => x.action === "update"),
    false,
  );
  await ulda.data.item.value.update(3);
});

test("content Delete updates master atomically; SuperDelete removes remaining content and master", async (t) => {
  const { server, ulda, masterId } = await setup(t);
  await ulda.add("one", { value: 1 });
  await ulda.add("two", { value: 2 }, "S");
  await ulda.delete("one");
  assert.deepEqual(Object.keys(ulda.snapshot()), ["two"]);
  assert.equal(server.records.size, 2);
  const response = await ulda.superDelete();
  assert.equal(response.ok, true);
  assert.equal(server.records.size, 0);
  const packets = server.frames.filter((x) => x.action === "delete");
  assert.equal(packets.length, 2);
  assert.ok(packets[0].body.at(-1).payload instanceof Uint8Array);
  assert.equal(packets[0].body.at(-1).id, masterId);
});

test("two writers: exactly one same-age update commits; loser refreshes and explicitly reapplies", async (t) => {
  const { server, ulda, client, masterId, password } = await setup(t);
  await ulda.add("shared", { first: 0, second: 0 });
  const other = client();
  await other.connect(masterId, password);
  server.faults.push(
    { action: "update", dropChanged: true },
    { action: "update", dropChanged: true },
  );
  const results = await Promise.allSettled([
    ulda.data.shared.first.update(1),
    other.data.shared.second.update(2),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "CONFLICT",
  );
  const loser = results[0].status === "rejected" ? ulda : other;
  await loser.refresh();
  if (loser === ulda) await loser.data.shared.first.update(1);
  else await loser.data.shared.second.update(2);
  assert.equal(loser.data.shared.first.get(), 1);
  assert.equal(loser.data.shared.second.get(), 2);
});

test("concurrent adds: failed second member prevents first-member content commit; retry reuses ID", async (t) => {
  const { server, ulda, client, masterId, password } = await setup(t);
  const other = client();
  await other.connect(masterId, password);
  server.faults.push(
    { action: "update", dropChanged: true },
    { action: "update", dropChanged: true },
  );
  const results = await Promise.allSettled([
    ulda.add("a", 1),
    other.add("b", 2),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "CONFLICT",
  );
  assert.equal(server.records.size, 3);
  const ages = [...server.records.values()]
    .filter((x) => x.id !== masterId)
    .map((x) => parseWitness(x.witness).age)
    .sort();
  assert.deepEqual(ages, [0, 1]);
  const loser = results[0].status === "rejected" ? ulda : other;
  await loser.refresh();
  await loser.add(loser === ulda ? "a" : "b", loser === ulda ? 1 : 2);
  assert.equal(server.records.size, 3);
  assert.equal(loser.snapshot().a, 1);
  assert.equal(loser.snapshot().b, 2);
});

test("lost Create ACK is never replayed; unknown ID prevents repeating add", async (t) => {
  const { server, ulda } = await setup(t, 150);
  server.faults.push({ action: "create", dropAck: true });
  await assert.rejects(ulda.add("secret name", "secret body"), {
    code: "UNKNOWN_OUTCOME",
  });
  const count = server.frames.filter((x) => x.action === "create").length;
  await assert.rejects(ulda.add("secret name", "secret body"), {
    code: "NEEDS_RESYNC",
  });
  assert.equal(
    server.frames.filter((x) => x.action === "create").length,
    count,
  );
});

test("drop before commit remains blocked after reading old state", async (t) => {
  const { server, ulda } = await setup(t, 150);
  await ulda.add("item", { value: 1 });
  server.faults.push({ action: "update", dropRequest: true });
  await assert.rejects(ulda.data.item.value.update(2), {
    code: "UNKNOWN_OUTCOME",
  });
  await ulda.refresh();
  assert.equal(ulda.status, "needsResync");
  assert.throws(() => ulda.data.item.value.update(3), { code: "NEEDS_RESYNC" });
  assert.equal(ulda.data.item.value.get(), 1);
});

test("malformed success ACK is unknown, and arbitrary server error text is not exposed", async (t) => {
  const { server, client, password } = await setup(t);
  const ulda = client();
  server.faults.push({
    action: "create",
    response: () => ({ ok: true, data: ["not-an-id"] }),
  });
  await assert.rejects(ulda.register(password), { code: "UNKNOWN_OUTCOME" });
  server.faults.push({ action: "create", error: password });
  await assert.rejects(
    ulda.register(password),
    (error) =>
      error.code === "SERVER_ERROR" &&
      !JSON.stringify(error).includes(password) &&
      !error.message.includes(password),
  );
});

test("late ACK cannot roll back newer confirmed S data", async (t) => {
  const { server, ulda } = await setup(t, 500);
  await ulda.add("stream", { value: 0 }, "S");
  server.faults.push(
    { action: "update", ackDelay: 200, dropChanged: true },
    { action: "update", ackDelay: 10, dropChanged: true },
  );
  const first = ulda.data.stream.value.update(1),
    second = ulda.data.stream.value.update(2);
  await second;
  assert.equal(ulda.data.stream.value.get(), 2);
  await first;
  assert.equal(ulda.data.stream.value.get(), 2);
});

test("close during pending writes does not restart or expose private state", async (t) => {
  const { server, ulda } = await setup(t, 200);
  await ulda.add("item", { value: 1 });
  server.faults.push({ action: "update", dropAck: true, dropChanged: true });
  const attempt = ulda.data.item.value.update(2);
  const outcome = Promise.allSettled([attempt]);
  await wait(20);
  await ulda.close();
  const result = await outcome;
  assert.equal(result[0].status, "rejected");
  assert.equal(ulda.status, "closed");
  assert.equal(JSON.stringify(ulda), "{}");
  await assert.rejects(ulda.reconnect(), { code: "CLOSED" });
  assert.equal(
    [...server.watchers.values()].every((set) => set.size === 0),
    true,
  );
});

test("large Read splits only reads into arrays, while opening remains all-or-error", async (t) => {
  const { server, ulda, client, masterId, password } = await setup(t);
  await ulda.add("one", 1);
  await ulda.add("two", 2);
  server.faults.push({
    action: "read",
    match: (body) => body.length > 1,
    error: "too_large",
  });
  const before = server.frames.length;
  const other = client();
  await other.connect(masterId, password);
  assert.equal(other.snapshot().one, 1);
  assert.equal(other.snapshot().two, 2);
  const reads = server.frames.slice(before).filter((x) => x.action === "read");
  assert.deepEqual(
    reads.map((x) => x.body.length),
    [1, 2, 1, 1],
  );
});

test("unknown add completion is discovered by refresh without repeating Create", async (t) => {
  const { server, ulda } = await setup(t, 150);
  server.faults.push({ action: "update", dropAck: true, dropChanged: true });
  await assert.rejects(ulda.add("new", { value: 7 }), {
    code: "UNKNOWN_OUTCOME",
  });
  assert.equal(ulda.status, "needsResync");
  const creates = server.frames.filter((x) => x.action === "create").length;
  await ulda.refresh();
  assert.equal(ulda.status, "open");
  assert.equal(ulda.data.new.value.get(), 7);
  assert.equal(
    server.frames.filter((x) => x.action === "create").length,
    creates,
  );
  await ulda.data.new.value.update(8);
});
