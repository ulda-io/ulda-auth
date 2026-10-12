import { test } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionIndex } from "./subscription-index.js";
import { fixture } from "./server.js";
import { SocketIoTransport, Ulda } from "../src/index.js";
import { contentCredentials, newContentSecret, newToken, seal } from "../src/crypto.js";
import { newOrigin, advance } from "../src/core.js";
import { emptyPacket, readPacket, writePacket, deletePacket, deletionProof } from "../src/protocol.js";

test("indexes deduplicate reads; disconnect and deletion clean both sides and empty sets", () => {
  const index = new SubscriptionIndex(), a = { connected: true }, b = { connected: true };
  index.subscribe(a, ["1", "2"]); index.subscribe(a, ["1"]); index.subscribe(b, ["2"]);
  assert.equal(index.byResource.get("1").size, 1);
  assert.equal(index.bySocket.get(a).size, 2);
  const pushes = index.recipients([{ id: "1" }], ["2"]);
  assert.deepEqual(pushes.get(a), { updated: [{ id: "1" }], deleted: ["2"] });
  assert.deepEqual(pushes.get(b), { updated: [], deleted: ["2"] });
  index.remove(["2"]);
  assert.equal(index.bySocket.has(b), false);
  assert.deepEqual([...index.bySocket.get(a)], ["1"]);
  index.disconnect(a); index.disconnect(a);
  assert.equal(index.bySocket.size, 0); assert.equal(index.byResource.size, 0);
  index.subscribe({ connected: false }, ["1"]);
  assert.equal(index.bySocket.size, 0); assert.equal(index.byResource.size, 0);
});

test("routing and disconnect do not traverse unrelated resources or connections", () => {
  const index = new SubscriptionIndex(), a = { connected: true }, b = { connected: true };
  index.subscribe(a, ["1"]); index.subscribe(b, ["2"]);
  // Fail if implementation starts scanning all keys/entries instead of targeted lookups.
  for (const map of [index.byResource, index.bySocket]) {
    for (const name of ["keys", "values", "entries", "forEach", Symbol.iterator])
      map[name] = () => { throw new Error("Global subscription scan"); };
  }
  index.byResource.get("2")[Symbol.iterator] = () => { throw new Error("Unrelated subscribers scanned"); };
  const recipients = index.recipients([{ id: "1" }], []);
  assert.equal(recipients.size, 1); assert.equal(recipients.has(a), true);
  index.disconnect(a);
  assert.equal(index.byResource.has("1"), false);
  assert.equal(index.byResource.get("2").has(b), true);
});

test("wire records are generic; Read subscribes only its IDs and one batch produces one push per recipient", async t => {
  const server = await fixture();
  const clients = [0, 1, 2].map(() => new SocketIoTransport(server.url, { allowInsecureLocalhost: true }));
  t.after(async () => { clients.forEach(x => x.close()); await server.close(); });
  await Promise.all(clients.map(x => x.start()));
  const states = await Promise.all([0, 1].map(async () => ({ credentials: await contentCredentials(newContentSecret()), token: newToken(), origin: newOrigin("X") })));
  const ids = await clients[0].send(writePacket("create", await Promise.all(states.map(async s => ({ sealed: await seal(s.credentials, s.token, s.origin, null) })))));
  assert.deepEqual([...server.watchers.keys()], ids); // subscribed by Create, before any Read
  await clients[0].send(readPacket(ids));
  await clients[1].send(readPacket([ids[1]]));
  await clients[1].send(readPacket([ids[1]]));
  const pushes = clients.map(() => []);
  clients.forEach((c, i) => c.on("changed", value => pushes[i].push(value)));
  const updates = await Promise.all(states.map(async (s, i) => {
    s.origin = advance(s.origin);
    return { id: ids[i], sealed: await seal(s.credentials, s.token, s.origin, { value: i }) };
  }));
  await clients[0].send(writePacket("update", updates));
  // Hello ACKs are queued after Changed on each connection; no timing-only assertions.
  await Promise.all(clients.map(c => c.send(emptyPacket("hello"))));
  assert.deepEqual(pushes.map(x => x.length), [0, 1, 0]);
  assert.deepEqual(pushes[1][0].updated.map(x => x.id), [ids[1]]);
  assert.deepEqual([...server.watchers.values()].map(x => x.size), [1, 2]);
  assert.deepEqual([...server.subscriptions.values()].map(x => x.size).sort(), [1, 2]);
  for (const record of server.records.values()) assert.deepEqual(Object.keys(record).sort(), ["id", "payload", "witness"]);
  for (const frame of server.frames) {
    const encoded = JSON.stringify(frame.body);
    for (const forbidden of ['"kind"', '"master"', '"content"', '"time"', '"durationMs"', '"connection"', '"origin"'])
      assert.equal(encoded.includes(forbidden), false);
  }
  await clients[0].send(deletePacket([await deletionProof(ids[1], states[1].origin)]));
  await Promise.all(clients.map(c => c.send(emptyPacket("hello"))));
  assert.deepEqual(pushes[1].at(-1).deleted, [ids[1]]);
  assert.equal(server.watchers.has(ids[1]), false);
  assert.equal(server.subscriptions.size, 1);
  await clients[0].send(emptyPacket("session.close"));
  assert.equal(server.watchers.size, 0); assert.equal(server.subscriptions.size, 0);
});

test('Update subscribes an unread connection, failed batches add no subscriptions, reconnect starts empty', async t => {
  const server = await fixture();
  const clients = [0,1,2].map(() => new SocketIoTransport(server.url, {allowInsecureLocalhost:true}));
  t.after(async () => { clients.forEach(c => c.close()); await server.close(); });
  await Promise.all(clients.map(c => c.start()));
  const credentials = await contentCredentials(newContentSecret()), token = newToken();
  const origins = [newOrigin(), newOrigin()];
  const sealed = await Promise.all(origins.map(o => seal(credentials, token, o, null)));
  const ids = await clients[0].send(writePacket('create', sealed.map(sealed => ({sealed}))));
  const nextOrigin = advance(origins[0]);
  const candidate = await seal(credentials,token,nextOrigin,{value:1});
  await assert.rejects(clients[1].send(readPacket([ids[0], '999999'])), {code:'NOT_FOUND'});
  await assert.rejects(clients[1].send(writePacket('update', [
    {id:ids[0],sealed:candidate}, {id:ids[1],sealed:sealed[1]},
  ])), {code:'CONFLICT'});
  assert.deepEqual([...server.watchers.values()].map(x => x.size), [1,1]);
  assert.equal(server.subscriptions.size,1);
  await clients[1].send(writePacket('update', [{id:ids[0],sealed:candidate}]));
  assert.equal(server.watchers.get(ids[0]).size,2);
  assert.equal(server.subscriptions.size,2);
  const changes=[]; clients[1].on('changed', event => changes.push(event));
  await clients[1].send(emptyPacket('hello')); changes.length=0;
  await clients[0].send(writePacket('update', [{id:ids[0],sealed:await seal(credentials,token,advance(nextOrigin),{value:2})}]));
  await clients[1].send(emptyPacket('hello'));
  assert.equal(changes.length,1);
  assert.deepEqual(changes[0].updated.map(x=>x.id),[ids[0]]);
  await clients[1].send(emptyPacket('session.close'));
  assert.equal(server.subscriptions.size,1);
  clients[1].disconnect(); await clients[1].start(); await clients[1].send(emptyPacket('hello'));
  assert.equal(server.subscriptions.size,1);
  await clients[1].send(readPacket([ids[1]]));
  assert.equal(server.watchers.get(ids[1]).size,2);
  await clients[1].send(readPacket([ids[1]]));
  assert.equal(server.watchers.get(ids[1]).size,2);
});

test('successful Create subscribes even if ACK is lost; rejected Create does not', async t => {
  const server=await fixture();
  const transport=new SocketIoTransport(server.url,{allowInsecureLocalhost:true,timeout:100});
  t.after(async()=>{transport.close();await server.close();});
  await transport.start();
  const credentials=await contentCredentials(newContentSecret()), token=newToken(), origin=newOrigin();
  await assert.rejects(transport.send(writePacket('create',[{sealed:await seal(credentials,token,advance(origin),null)}])),{code:'CONFLICT'});
  assert.equal(server.records.size,0); assert.equal(server.subscriptions.size,0);
  server.faults.push({action:'create',dropAck:true});
  await assert.rejects(transport.send(writePacket('create',[{sealed:await seal(credentials,token,origin,null)}])),{code:'UNKNOWN_OUTCOME'});
  assert.equal(server.records.size,1); assert.equal(server.subscriptions.size,1);
  assert.equal(server.watchers.values().next().value.size,1);
});

test('SDK add sends only Create and Update; subscriber receives later edits without subscription Read', async t => {
  const server=await fixture(), clients=[];
  const client=()=>{const ulda=new Ulda(server.url,{allowInsecureLocalhost:true});clients.push(ulda);return ulda;};
  t.after(async()=>{for(const ulda of clients) await ulda.close();await server.close();});
  const ulda=client(), password='synthetic-auto-subscribe';
  const master=await ulda.register(password);
  const start=server.frames.length;
  assert.equal((await ulda.add('test',{value:1})).subscriptionReady,true);
  assert.deepEqual(server.frames.slice(start).map(x=>x.action),['create','update']);
  const other=client(); await other.connect(master,password); await other.update('test',{value:2});
  for(let i=0;i<100&&ulda.value('test').value!==2;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(ulda.value('test').value,2);
});
