import { createServer } from "node:http";
import { Server } from "socket.io";
import { requestShape, messageSize } from "../src/protocol.js";
import { parseWitness, verify } from "../src/core.js";
import { SERVER_STEPS, stepRecord } from "../src/diagnostics.js";
import { SubscriptionIndex } from "./subscription-index.js";
import { socketParser } from "../src/socket-parser.js";

// Contract fixture only. No authentication, disk persistence or production deployment.
export async function fixture({ diagnostics = false } = {}) {
  const http = createServer();
  const io = new Server(http, {
    maxHttpBufferSize: 75_000_000,
    transports: ["websocket"],
    parser: socketParser,
  });
  const subscriptions = new SubscriptionIndex();
  const records = new Map(),
    watchers = subscriptions.byResource,
    frames = [],
    faults = [],
    commits = [];
  let counter = 100n,
    tail = Promise.resolve();
  const clone = (x) => structuredClone(x);
  function trace(socket, action, step, ids = [], count = 0) {
    if (!diagnostics) return;
    try { socket.emit("ulda:diagnostic", { ...stepRecord(SERVER_STEPS, step, ids, count), action }); }
    catch { /* Observability must not change storage results. */ }
  }
  function cleanup(socket) {
    subscriptions.disconnect(socket);
  }
  function broadcast(updated, deleted, author) {
    const recipients = subscriptions.recipients(updated, deleted, author);
    subscriptions.remove(deleted);
    for (const [socket, changes] of recipients) {
        trace(socket, "changed", "changed.sent", [...changes.updated.map(x => x.id), ...changes.deleted]);
        socket.emit("ulda:changed", clone(changes));
    }
  }
  io.on("connection", (socket) => {
    socket.on("disconnect", () => cleanup(socket));
    for (const action of [
      "hello",
      "read",
      "create",
      "update",
      "delete",
      "session.close",
    ])
      socket.on(`ulda:${action}`, (body, callback) => {
        if (typeof callback !== "function") return;
        frames.push({ action, body: clone(body), socket: socket.id });
        const index = faults.findIndex(
          (f) => f.action === action && (!f.match || f.match(body)),
        );
        const fault = index < 0 ? {} : faults.splice(index, 1)[0];
        if (fault.dropRequest) return;
        const reply = (response) => {
          if (!fault.dropAck) {
            const responseBody = fault.response
              ? fault.response(response)
              : response;
            const deliver = () => {
              trace(socket, action, response.ok ? "reply.ok" : "reply.error");
              callback(responseBody);
            };
            if (fault.holdAck) fault.holdAck(deliver);
            else if (fault.ackDelay) setTimeout(deliver, fault.ackDelay);
            else deliver();
          }
        };
        const run = async () => {
          try {
            requestShape(action, body);
            trace(socket, action, "request.validated");
          } catch {
            reply({ ok: false, error: "invalid_request" });
            return;
          }
          if (fault.error) {
            reply({ ok: false, error: fault.error });
            return;
          }
          if (action === "hello") {
            trace(socket, action, "hello.ready");
            reply({ ok: true });
            return;
          }
          if (action === "session.close") {
            cleanup(socket);
            trace(socket, action, "session.unsubscribed");
            reply({ ok: true });
            return;
          }
          if (action === "read") {
            trace(socket, action, "read.lookup", body, body.length);
            if (body.some((key) => !records.has(key))) {
              reply({ ok: false, error: "not_found" });
              return;
            }
            const data = body.map((key) => clone(records.get(key)));
            trace(socket, action, "read.found", body, data.length);
            try {
              messageSize(data);
            } catch {
              reply({ ok: false, error: "too_large" });
              return;
            }
            subscriptions.subscribe(socket, body);
            trace(socket, action, "read.subscribed", body, body.length);
            reply({ ok: true, data });
            return;
          }
          if (action === "create") {
            if (body.some((x) => parseWitness(x.witness).age !== 0)) {
              reply({ ok: false, error: "invalid_witness" });
              return;
            }
            trace(socket, action, "create.validated", [], body.length);
            const data = body.map((x) => {
              const key = String(++counter);
              records.set(key, { id: key, ...clone(x) });
              return key;
            });
            commits.push({ action, ids: data });
            trace(socket, action, "create.committed", data, data.length);
            subscriptions.subscribe(socket, data);
            trace(socket, action, "create.subscribed", data, data.length);
            reply({ ok: true, data });
            return;
          }
          for (const item of body) {
            trace(socket, action, "write.lookup", [item.id]);
            const current = records.get(item.id);
            if (!current) {
              reply({ ok: false, error: "not_found", id: item.id });
              return;
            }
            const from = parseWitness(current.witness),
              to = parseWitness(item.witness);
            if (to.age <= from.age || !(await verify(from.bytes, to.bytes))) {
              reply({ ok: false, error: "conflict", id: item.id });
              return;
            }
            trace(socket, action, "write.verified", [item.id]);
          }
          const updated = [],
            deleted = [];
          for (const item of body) {
            if (action === "delete" && !Object.hasOwn(item, "payload")) {
              records.delete(item.id);
              deleted.push(item.id);
            } else {
              records.set(item.id, clone(item));
              updated.push(clone(item));
            }
          }
          commits.push({ action, ids: body.map((x) => x.id) });
          trace(socket, action, "write.committed", body.map(x => x.id), body.length);
          const updatedIds = updated.map(x => x.id);
          if (updatedIds.length) {
            subscriptions.subscribe(socket, updatedIds);
            trace(socket, action, "write.subscribed", updatedIds, updatedIds.length);
          }
          reply({ ok: true });
          if (!fault.dropChanged) broadcast(updated, deleted, socket);
          else subscriptions.remove(deleted);
        };
        tail = tail
          .then(run)
          .catch(() => reply({ ok: false, error: "storage_error" }));
      });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    records,
    watchers,
    subscriptions: subscriptions.bySocket,
    frames,
    faults,
    commits,
    io,
    async drain() {
      await tail;
    },
    async close() {
      await new Promise((resolve) => io.close(resolve));
    },
    sendChanged(event) {
      for (const socket of io.sockets.sockets.values())
        socket.emit("ulda:changed", clone(event));
    },
  };
}
