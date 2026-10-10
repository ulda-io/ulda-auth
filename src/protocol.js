import { check, fail } from "./errors.js";
import { id, exact, binary, LIMITS } from "./values.js";
import { parseWitness, sign, advance } from "./core.js";
import { sealedWire, envelope } from "./crypto.js";

const packets = new WeakMap();
const deletionProofs = new WeakMap();
const actions = new Set([
  "hello",
  "read",
  "create",
  "update",
  "delete",
  "session.close",
]);
const put = (action, body) => {
  const p = Object.freeze(Object.create(null));
  packets.set(p, { action, body });
  return p;
};
function array(items) {
  check(
    Array.isArray(items) && items.length > 0 && items.length <= LIMITS.batch,
    "INVALID_PACKET",
  );
}
function ids(items) {
  array(items);
  items.forEach(id);
  check(new Set(items).size === items.length, "INVALID_PACKET");
}
export function messageSize(items) {
  let size = 0;
  for (const item of items) {
    size += binary(item?.witness, 167).byteLength;
    if (Object.hasOwn(item, "payload")) size += binary(item.payload).byteLength;
    check(size <= LIMITS.messageBytes, "LIMIT");
  }
}
export function emptyPacket(action) {
  check(action === "hello" || action === "session.close");
  return put(action, {});
}
export function readPacket(resourceIds) {
  ids(resourceIds);
  return put("read", [...resourceIds]);
}
export function writePacket(action, items) {
  check(action === "create" || action === "update");
  array(items);
  if (action === "update") ids(items.map((x) => x.id));
  const body = items.map((item) =>
    action === "create"
      ? { ...sealedWire(item.sealed) }
      : { id: id(item.id), ...sealedWire(item.sealed) },
  );
  return put(action, body);
}
export async function deletionProof(resourceId, origin) {
  id(resourceId);
  const handle = Object.freeze(Object.create(null));
  const next = advance(origin);
  try {
    deletionProofs.set(handle, { id: resourceId, witness: await sign(next) });
  } finally { next.fill(0); }
  return handle;
}
export function deletePacket(proofs, updates = []) {
  array(proofs);
  const body = proofs.map((proof) => {
    check(deletionProofs.has(proof), "INVALID_PACKET");
    return { ...deletionProofs.get(proof) };
  });
  check(Array.isArray(updates), "INVALID_PACKET");
  for (const item of updates) body.push({ id: id(item.id), ...sealedWire(item.sealed) });
  array(body);
  messageSize(body);
  ids(body.map((x) => x.id));
  return put("delete", body);
}
export function outgoing(packet) {
  check(packets.has(packet), "INVALID_PACKET");
  const { action, body } = packets.get(packet);
  // A defensive copy: a transport/observer cannot mutate a later retry or local state.
  return { action, body: Array.isArray(body) ? body.map(item =>
    typeof item === "string" ? item : {
      ...(item.id === undefined ? {} : { id: item.id }),
      witness: binary(item.witness, 167).slice(),
      ...(item.payload === undefined ? {} : { payload: binary(item.payload).slice() }),
    }) : {} };
}
export function resource(value) {
  exact(value, ["id", "witness", "payload"]);
  id(value.id);
  parseWitness(value.witness);
  envelope(value.payload);
  return Object.freeze({
    id: value.id,
    witness: binary(value.witness, 167).slice(),
    payload: binary(value.payload).slice(),
  });
}
export function requestShape(action, body) {
  check(actions.has(action), "INVALID_PACKET");
  if (action === "hello" || action === "session.close") {
    exact(body, []);
    return;
  }
  if (action === "read") {
    ids(body);
    return;
  }
  array(body);
  if (action !== "delete") messageSize(body);
  else {
    check(body.some(item => !Object.hasOwn(item, "payload")), "INVALID_PACKET");
    messageSize(body);
  }
  if (action !== "create") ids(body.map((x) => x.id));
  body.forEach((x) => {
    exact(
      x,
      action === "create"
        ? ["witness", "payload"]
        : action === "update"
          ? ["id", "witness", "payload"]
          : Object.hasOwn(x, "payload") ? ["id", "witness", "payload"] : ["id", "witness"],
    );
    parseWitness(x.witness);
    if (action !== "delete" || Object.hasOwn(x, "payload")) envelope(x.payload);
  });
}
export function acknowledgement(action, body, raw) {
  check(
    raw && typeof raw === "object" && !Array.isArray(raw),
    "INVALID_PACKET",
  );
  if (raw.ok === false) {
    exact(
      raw,
      Object.hasOwn(raw, "id") ? ["ok", "error", "id"] : ["ok", "error"],
    );
    if (Object.hasOwn(raw, "id")) id(raw.id);
    // Never copy arbitrary server messages, payload or stack traces into application errors.
    const codes = {
      conflict: "CONFLICT",
      not_found: "NOT_FOUND",
      too_large: "LIMIT",
      unsupported_profile: "UNSUPPORTED_PROFILE",
      invalid_witness: "CONFLICT",
    };
    fail(
      typeof raw.error === "string" && Object.hasOwn(codes, raw.error)
        ? codes[raw.error]
        : "SERVER_ERROR",
    );
  }
  check(raw.ok === true, "INVALID_PACKET");
  if (action === "read" || action === "create") {
    exact(raw, ["ok", "data"]);
    array(raw.data);
    check(raw.data.length === body.length, "INVALID_PACKET");
    if (action === "create") {
      ids(raw.data);
      return [...raw.data];
    }
    messageSize(raw.data);
    const records = raw.data.map(resource);
    ids(records.map((x) => x.id));
    check(
      records.every((x) => body.includes(x.id)),
      "INVALID_PACKET",
    );
    return records;
  }
  exact(raw, ["ok"]);
  return undefined;
}
export function changed(raw) {
  check(raw && typeof raw === "object", "INVALID_PACKET");
  exact(
    raw,
    ["updated", "deleted"].filter((key) => Object.hasOwn(raw, key)),
  );
  const inputUpdated = raw.updated ?? [],
    inputDeleted = raw.deleted ?? [];
  check(
    Array.isArray(inputUpdated) &&
      Array.isArray(inputDeleted) &&
      inputUpdated.length + inputDeleted.length <= LIMITS.batch,
    "INVALID_PACKET",
  );
  messageSize(inputUpdated);
  const updated = inputUpdated.map(resource),
    deleted = inputDeleted.map(id);
  const all = [...updated.map((x) => x.id), ...deleted];
  check(all.length > 0 && new Set(all).size === all.length, "INVALID_PACKET");
  return { updated, deleted };
}
