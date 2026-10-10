import { check } from "./errors.js";

// All nodes are explicit references, including primitives. .get() returns plain JSON.
export function reference(sdk, ensure, content, path = []) {
  const child = (key) => {
    ensure();
    return reference(sdk, ensure, content, [...path, String(key)]);
  };
  const methods = {
    get: () => {
      ensure();
      return sdk.value(content, path);
    },
    update: (value) => {
      ensure();
      return sdk.set(content, path, value);
    },
    delete: () => {
      ensure();
      return path.length ? sdk.remove(content, path) : sdk.delete(content);
    },
    field: child,
    toJSON: () => {
      ensure();
      return sdk.value(content, path);
    },
  };
  return new Proxy(Object.create(null), {
    get: (_, key) => {
      if (key === "then" || typeof key === "symbol") return undefined;
      return Object.hasOwn(methods, key) ? methods[key] : child(key);
    },
    set: () => {
      check(false, "UNSUPPORTED");
    },
    deleteProperty: () => {
      check(false, "UNSUPPORTED");
    },
    defineProperty: () => {
      check(false, "UNSUPPORTED");
    },
  });
}
export function dataTree(sdk, generation) {
  return new Proxy(Object.create(null), {
    get: (_, key) => {
      check(sdk.contextGeneration === generation, "STALE_REFERENCE");
      if (key === "then" || typeof key === "symbol") return undefined;
      if (key === "toJSON") return () => sdk.snapshot();
      if (key === "field") return (name) => sdk.ref(name);
      return sdk.ref(key);
    },
    set: () => {
      check(false, "UNSUPPORTED");
    },
    deleteProperty: () => {
      check(false, "UNSUPPORTED");
    },
    defineProperty: () => {
      check(false, "UNSUPPORTED");
    },
  });
}
