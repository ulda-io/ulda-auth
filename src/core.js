import UldaSign from "ulda-core";
import { check, fail } from "./errors.js";
import { binary, equal } from "./values.js";

const instances = Object.fromEntries(
  ["X", "S"].map((mode) => [
    mode,
    new UldaSign({
      fmt: { export: "bytes" },
      sign: { mode, N: 5, hash: "SHA-256", originSize: 256, pack: "compactV1" },
    }),
  ]),
);
export function inspect(bytes) {
  try {
    check(
      bytes instanceof Uint8Array && bytes.length >= 163 && bytes.length <= 167,
      "UNSUPPORTED_PROFILE",
    );
    const p = instances.X.actions.import.signature(bytes);
    check(
      p.N === 5 &&
        p.alg === "SHA-256" &&
        (p.mode === "X" || p.mode === "S") &&
        p.body.length === 160,
      "UNSUPPORTED_PROFILE",
    );
    const canonical = instances[p.mode].codec.encodeWitness(p.body, {
      index: p.index,
      mode: p.mode,
      N: 5,
      hash: "SHA-256",
    });
    check(equal(canonical, bytes), "UNSUPPORTED_PROFILE");
    return { mode: p.mode, age: Number(p.index), N: 5 };
  } catch {
    fail("UNSUPPORTED_PROFILE");
  }
}
export const parseWitness = (value) => {
  const bytes = binary(value, 167);
  return { bytes, ...inspect(bytes) };
};
export function newOrigin(mode = "X") {
  check(mode === "X" || mode === "S");
  return instances[mode].New();
}
export function advance(origin) {
  const p = inspect(origin);
  check(p.age < 0xffffffff, "LIMIT");
  return instances[p.mode].stepUp(origin);
}
export async function sign(origin) {
  const p = inspect(origin);
  return instances[p.mode].sign(origin);
}
export async function verify(previous, candidate) {
  const a = inspect(previous),
    b = inspect(candidate);
  if (a.mode !== b.mode) return false;
  try {
    return await instances[a.mode].verify(previous, candidate);
  } catch {
    return false;
  }
}
