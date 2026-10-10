import { check } from "./errors.js";
export const LIMITS = Object.freeze({
  jsonBytes: 1_048_576,
  payloadBytes: 1_100_000,
  messageBytes: 8_388_608,
  incoming: 8,
  batch: 64,
  resources: 64,
  queue: 128,
  depth: 48,
  nodes: 40_000,
});
export const utf8 = (text) => new TextEncoder().encode(text);
export const equal = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export function concat(...parts) {
  const result = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let i = 0;
  for (const b of parts) {
    result.set(b, i);
    i += b.length;
  }
  return result;
}
export const random = (n) =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));
// Accept the two forms delivered by Socket.IO: Buffer/Uint8Array and ArrayBuffer.
// Keep view bounds; never expose the rest of a pooled Buffer's backing allocation.
export function binary(value, limit = LIMITS.payloadBytes) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer)
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else check(false, "INVALID_PACKET");
  check(bytes.byteLength > 0 && bytes.byteLength <= limit, "INVALID_PACKET");
  return bytes;
}
export function b64(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unb64(text, limit = LIMITS.payloadBytes) {
  check(
    typeof text === "string" &&
      text.length > 0 &&
      text.length <= Math.ceil((limit * 4) / 3) &&
      /^[A-Za-z0-9_-]+$/.test(text) &&
      text.length % 4 !== 1,
    "INVALID_PACKET",
  );
  let bytes;
  try {
    bytes = Uint8Array.from(
      atob(text.replaceAll("-", "+").replaceAll("_", "/")),
      (x) => x.charCodeAt(0),
    );
  } catch {
    check(false, "INVALID_PACKET");
  }
  check(bytes.length <= limit && b64(bytes) === text, "INVALID_PACKET");
  return bytes;
}
export function id(value) {
  check(typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value));
  return value;
}
export function name(value) {
  check(typeof value === "string" && value.length > 0 && value.length <= 256);
  return value;
}
export function exact(value, keys) {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_PACKET",
  );
  check(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    "INVALID_PACKET",
  );
}
// Clone JSON without invoking getters, toJSON or custom prototypes.
export function json(value) {
  const seen = new Set();
  let nodes = 0,
    characters = 0;
  function visit(v, depth) {
    check(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, "LIMIT");
    if (typeof v === "string") {
      characters += v.length;
      check(characters <= LIMITS.jsonBytes, "LIMIT");
      return v;
    }
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      check(Number.isFinite(v));
      return v;
    }
    check(v && typeof v === "object" && !seen.has(v));
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    check(
      array
        ? proto === Array.prototype
        : proto === Object.prototype || proto === null,
    );
    seen.add(v);
    const result = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(v).filter((k) => !(array && k === "length"));
    if (array) check(keys.length === v.length && v.length <= LIMITS.nodes);
    for (const key of keys) {
      check(typeof key === "string");
      characters += key.length;
      check(characters <= LIMITS.jsonBytes, "LIMIT");
      if (array) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < v.length);
      const desc = Object.getOwnPropertyDescriptor(v, key);
      check(desc.enumerable && Object.hasOwn(desc, "value"));
      Object.defineProperty(result, key, {
        value: visit(desc.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    seen.delete(v);
    return result;
  }
  const result = visit(value, 0);
  check(utf8(JSON.stringify(result)).length <= LIMITS.jsonBytes, "LIMIT");
  return result;
}
export function pathValue(value, path) {
  let current = value;
  for (const key of path) {
    check(
      current !== null &&
        typeof current === "object" &&
        Object.hasOwn(current, key),
      "NOT_FOUND",
    );
    current = current[key];
  }
  return current;
}
export function edit(value, path, replacement, remove = false) {
  check(
    Array.isArray(path) &&
      path.length <= LIMITS.depth &&
      path.every((k) => typeof k === "string" || Number.isSafeInteger(k)),
  );
  if (!path.length) {
    check(!remove, "UNSUPPORTED");
    return json(replacement);
  }
  const result = json(value);
  const parent = pathValue(result, path.slice(0, -1));
  const key = String(path.at(-1));
  check(parent !== null && typeof parent === "object");
  if (Array.isArray(parent))
    check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < parent.length);
  if (remove) {
    check(Object.hasOwn(parent, key), "NOT_FOUND");
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  } else
    Object.defineProperty(parent, key, {
      value: json(replacement),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}
