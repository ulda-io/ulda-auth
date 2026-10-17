import { check, fail, UldaError } from "./errors.js";
import {
  b64,
  unb64,
  binary,
  random,
  concat,
  utf8,
  equal,
  json,
  exact,
  LIMITS,
} from "./values.js";
import { inspect, sign } from "./core.js";

const MAGIC = new Uint8Array([85, 76, 68, 2]);
const DOMAIN = utf8("ULDA-SDK/container/v2\0");
const CONTENT_KEY_DOMAIN = utf8("ULDA-SDK/content-key/v2");
const sealed = new WeakMap();
const ITERATIONS = 600000;
function webcrypto() {
  check(
    globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues,
    "UNSUPPORTED",
  );
  return globalThis.crypto.subtle;
}
function passwordBytes(password) {
  check(
    typeof password === "string" &&
      password.length > 0 &&
      password.length <= 1024,
  );
  return utf8(password);
}
async function masterKey(password, salt) {
  const secret = passwordBytes(password);
  password = undefined;
  try {
    const material = await webcrypto().importKey(
      "raw",
      secret,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    secret.fill(0);
    return await webcrypto().deriveKey(
      { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    if (error instanceof UldaError) throw error;
    fail("CRYPTO_FAILED");
  } finally {
    secret.fill(0);
  }
}
export async function masterCredentials(password, salt = random(16)) {
  check(salt instanceof Uint8Array && salt.length === 16);
  const deriving = masterKey(password, salt);
  password = undefined;
  return { salt: salt.slice(), key: await deriving };
}
export async function contentCredentials(secret, salt = random(16)) {
  check(salt instanceof Uint8Array && salt.length === 16);
  const bytes = unb64(secret, 32);
  secret = undefined;
  try {
    check(bytes.length === 32);
    const material = await webcrypto().importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    bytes.fill(0);
    return {
      salt: salt.slice(),
      key: await webcrypto().deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: CONTENT_KEY_DOMAIN },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    };
  } catch (error) {
    if (error instanceof UldaError) throw error;
    fail("CRYPTO_FAILED");
  } finally {
    bytes.fill(0);
  }
}
function randomSecret() {
  const bytes = random(32);
  try { return b64(bytes); }
  finally { bytes.fill(0); }
}
function checkToken(token) {
  const bytes = unb64(token, 32);
  try { check(bytes.length === 32); }
  finally { bytes.fill(0); }
}
export const newContentSecret = randomSecret;
export const newToken = randomSecret;
export function envelope(payload) {
  const bytes = binary(payload, LIMITS.resourceBytes);
  check(
    bytes.length >= 48 && equal(bytes.subarray(0, 4), MAGIC),
    "INVALID_PACKET",
  );
  return {
    bytes,
    salt: bytes.slice(4, 20),
    nonce: bytes.slice(20, 32),
    ciphertext: bytes.subarray(32),
    header: bytes.subarray(0, 20),
  };
}
export async function seal(credentials, token, origin, data, catalog = false) {
  checkToken(token);
  const witness = await sign(origin);
  check(credentials.salt instanceof Uint8Array && credentials.salt.length === 16);
  const header = concat(MAGIC, credentials.salt);
  const nonce = random(12);
  const plaintext = utf8(
    JSON.stringify({
      token,
      origin: b64(origin),
      data: json(data, catalog),
    }),
  );
  try {
    check(plaintext.length <= (catalog ? LIMITS.resourceBytes : LIMITS.payloadBytes) - 48, "LIMIT");
    const cipher = new Uint8Array(
      await webcrypto().encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: concat(DOMAIN, header, witness),
          tagLength: 128,
        },
        credentials.key,
        plaintext,
      ),
    );
    const handle = Object.freeze(Object.create(null));
    sealed.set(
      handle,
      Object.freeze({
        witness,
        payload: concat(header, nonce, cipher),
      }),
    );
    return handle;
  } catch (error) {
    if (error?.code === "LIMIT") throw error;
    fail("CRYPTO_FAILED");
  } finally {
    plaintext.fill(0);
  }
}
// This gate accepts only a handle actually produced by authenticated encryption.
export function sealedWire(handle) {
  check(sealed.has(handle), "INVALID_PACKET");
  const { witness, payload } = sealed.get(handle);
  return Object.freeze({ witness: witness.slice(), payload: payload.slice() });
}
export async function open(credentials, record, expectedToken, catalog = false) {
  let plaintext, origin, accepted = false;
  try {
    const witness = binary(record.witness, 167);
    inspect(witness);
    const e = envelope(record.payload);
    check(equal(e.salt, credentials.salt));
    plaintext = new Uint8Array(
      await webcrypto().decrypt(
        {
          name: "AES-GCM",
          iv: e.nonce,
          additionalData: concat(DOMAIN, e.header, witness),
          tagLength: 128,
        },
        credentials.key,
        e.ciphertext,
      ),
    );
    const decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    exact(decoded, ["token", "origin", "data"]);
    checkToken(decoded.token);
    check(expectedToken === undefined || decoded.token === expectedToken);
    origin = unb64(decoded.origin, 167);
    inspect(origin);
    check(equal(await sign(origin), witness));
    const result = {
      origin,
      token: decoded.token,
      data: json(decoded.data, catalog),
      witness,
      record: Object.freeze({
        id: record.id,
        witness: record.witness,
        payload: record.payload,
      }),
      ...inspect(witness),
    };
    accepted = true;
    return result;
  } catch {
    fail("CRYPTO_FAILED");
  } finally {
    plaintext?.fill(0);
    if (!accepted) origin?.fill(0);
  }
}
