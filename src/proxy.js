import { check } from "./errors.js";

// All nodes are explicit references, including primitives. .get() returns plain JSON.
export function reference(ulda, ensure, content, path = []) {
  const child = (key) => {
    ensure();
    return reference(ulda, ensure, content, [...path, String(key)]);
  };
  const methods = {
    get: () => {
      ensure();
      return ulda.value(content, path);
    },
    update: (value) => {
      ensure();
      return ulda.set(content, path, value);
    },
    delete: () => {
      ensure();
      return path.length ? ulda.remove(content, path) : ulda.delete(content);
    },
    field: child,
    toJSON: () => {
      ensure();
      return ulda.value(content, path);
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
export function dataTree(ulda, generation) {
  return new Proxy(Object.create(null), {
    get: (_, key) => {
      check(ulda.contextGeneration === generation, "STALE_REFERENCE");
      if (key === "then" || typeof key === "symbol") return undefined;
      if (key === "toJSON") return () => ulda.snapshot();
      if (key === "field") return (name) => ulda.ref(name);
      return ulda.ref(key);
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
