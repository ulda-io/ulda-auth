import { test } from "node:test";
import assert from "node:assert/strict";
import { newOrigin, sign, advance, verify, inspect } from "../src/core.js";
import {
  masterCredentials,
  contentCredentials,
  newContentSecret,
  newToken,
  seal,
  open,
  sealedWire,
  envelope,
} from "../src/crypto.js";
import { b64, unb64, json, edit } from "../src/values.js";
import {
  writePacket,
  outgoing,
  changed,
  deletePacket,
  deletionProof,
} from "../src/protocol.js";
import { SocketIoTransport } from "../src/transport.js";

test("ciphertext hides complete origin/data and authenticates witness, salt, nonce, token and tag", async () => {
  const credentials = await contentCredentials(newContentSecret()),
    token = newToken(),
    origin = newOrigin("X");
  const secret = "private-payload-unique-marker";
  const handle = await seal(credentials, token, origin, { secret });
  const wire = sealedWire(handle);
  assert.equal(JSON.stringify(handle), "{}");
  const payload = wire.payload;
  assert.equal(Buffer.from(payload).includes(Buffer.from(secret)), false);
  assert.equal(Buffer.from(payload).includes(Buffer.from(origin)), false);
  assert.equal(
    JSON.stringify(
      outgoing(writePacket("create", [{ sealed: handle }])),
    ).includes(b64(origin)),
    false,
  );
  const decoded = await open(credentials, { id: "1", ...wire }, token);
  assert.equal(decoded.data.secret, secret);
  for (const offset of [0, 3, 4, 19, 20, 31, 32, payload.length - 1]) {
    const changedPayload = payload.slice();
    changedPayload[offset] ^= 1;
    await assert.rejects(
      open(credentials, { ...wire, payload: changedPayload }, token),
      { code: "CRYPTO_FAILED" },
    );
  }
  await assert.rejects(
    open(
      credentials,
      { ...wire, witness: await sign(advance(origin)) },
      token,
    ),
    { code: "CRYPTO_FAILED" },
  );
  await assert.rejects(open(credentials, wire, newToken()), {
    code: "CRYPTO_FAILED",
  });
  await assert.rejects(
    open(await contentCredentials(newContentSecret()), wire, token),
    { code: "CRYPTO_FAILED" },
  );
});

test("both resource roles use one v2 layout with random salts and no role marker", async () => {
  const secret = newContentSecret();
  const master = await masterCredentials("format-test-password");
  const content = await contentCredentials(secret);
  const second = await contentCredentials(secret);
  assert.notDeepEqual(content.salt, second.salt);
  assert.notDeepEqual(master.salt, content.salt);
  for (const credentials of [master, content]) {
    assert.equal(Object.hasOwn(credentials, "kind"), false);
    assert.equal(credentials.key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("raw", credentials.key));
    const data = { marker: "private-content" }, token = newToken();
    const wire = sealedWire(await seal(credentials, token, newOrigin("X"), data));
    assert.deepEqual(Object.keys(wire).sort(), ["payload", "witness"]);
    const e = envelope(wire.payload);
    assert.deepEqual([...e.header.slice(0, 4)], [85, 76, 68, 2]);
    assert.equal(e.header.length, 20);
    assert.equal(e.nonce.length, 12);
    assert.deepEqual(e.salt, credentials.salt);
    assert.equal(e.salt.every(x => x === 0), false);
    assert.equal(Object.hasOwn(e, "kind"), false);
    assert.deepEqual((await open(credentials, wire, token)).data, json(data));
    if (credentials === content) {
      const reopened = await contentCredentials(secret, e.salt);
      assert.deepEqual((await open(reopened, wire, token)).data, json(data));
      await assert.rejects(open(second, wire, token), { code: "CRYPTO_FAILED" });
      // A matching declared salt cannot rescue a key derived with a different salt.
      await assert.rejects(open({ ...second, salt: e.salt }, wire, token), { code: "CRYPTO_FAILED" });
    }
    const old = e.bytes.slice(); old[3] = 1;
    assert.throws(() => envelope(old), { code: "INVALID_PACKET" });
  }
});

test("witness is 160 raw hash bytes plus 3 or 7 compact header bytes, Base64URL has no padding", async () => {
  for (const mode of ["X", "S"]) {
    const origin = newOrigin(mode);
    const initial = await sign(origin), next = await sign(advance(origin));
    assert.equal(inspect(initial).age, 0);
    assert.equal(inspect(next).age, 1);
    assert.equal(initial.length, 3 + 5 * 32);
    assert.equal(next.length, 7 + 5 * 32);
    assert.equal(b64(initial).length, 218);
    assert.equal(b64(next).length, 223);
    assert.match(b64(initial), /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(unb64(b64(next)), next);
  }
});

test("master KDF has fixed cost, random salt, wrong password fails without data in errors", async () => {
  const a = await masterCredentials("correct master password"),
    b = await masterCredentials("correct master password");
  assert.notDeepEqual(a.salt, b.salt);
  const encrypted = sealedWire(
    await seal(a, newToken(), newOrigin("X"), { contents: [] }),
  );
  await assert.rejects(
    open(await masterCredentials("wrong password", a.salt), encrypted),
    (error) =>
      error.code === "CRYPTO_FAILED" && !error.message.includes("password"),
  );
});

test("encryption is mandatory at the output gate; raw payload/origin cannot impersonate sealed handle", async () => {
  assert.throws(
    () =>
      writePacket("create", [
        { sealed: { witness: b64(newOrigin()), payload: "cleartext" } },
      ]),
    { code: "INVALID_PACKET" },
  );
  assert.throws(
    () => outgoing({ action: "create", body: [{ origin: "secret" }] }),
    { code: "INVALID_PACKET" },
  );
  const origin = newOrigin();
  assert.throws(() => deletePacket([{ id: "1", witness: b64(origin) }]), {
    code: "INVALID_PACKET",
  });
  const deletion = outgoing(deletePacket([await deletionProof("1", origin)]));
  assert.equal(JSON.stringify(deletion).includes(b64(origin)), false);
  const transport = new SocketIoTransport("https://example.invalid");
  await assert.rejects(transport.send({ action: "create", body: "private" }), {
    code: "INVALID_PACKET",
  });
  transport.close();
});

test("canonical core profile and directed X/S gaps", async () => {
  for (const mode of ["X", "S"]) {
    const origin = newOrigin(mode),
      first = await sign(origin);
    let step = origin;
    for (let gap = 1; gap <= 5; gap++) {
      step = advance(step);
      const next = await sign(step);
      assert.equal(
        await verify(first, next),
        mode === "X" ? gap === 1 : gap < 5,
      );
    }
    assert.equal(await verify(first, first), false);
    const reserved = first.slice();
    reserved[2] |= 0x20;
    assert.throws(() => inspect(reserved));
    assert.throws(() => inspect(new Uint8Array(500)));
  }
});

test("strict JSON rejects getters/cycles/custom objects and safely handles prototype keys", () => {
  let called = false;
  assert.throws(() =>
    json({
      get secret() {
        called = true;
        return 1;
      },
    }),
  );
  assert.equal(called, false);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => json(cycle));
  for (const value of [new Date(), NaN, undefined, 1n, [, 2], { x: undefined }])
    assert.throws(() => json(value));
  const edited = edit(
    JSON.parse('{"__proto__":{"value":0}}'),
    ["__proto__", "value"],
    1,
  );
  assert.equal(edited.__proto__.value, 1);
  assert.equal({}.value, undefined);
});

test("plaintext transport endpoints and credentials in URL are refused", () => {
  assert.throws(() => new SocketIoTransport("http://example.com"));
  assert.throws(() => new SocketIoTransport("https://user:pass@example.com"));
  assert.throws(
    () => new SocketIoTransport("https://example.com?password=secret"),
  );
  assert.throws(() => changed({ updated: [], deleted: [], origin: "private" }));
});
