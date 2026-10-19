# Security policy

## Report a vulnerability

Report vulnerabilities privately to [admin@ulda.io](mailto:admin@ulda.io). You may also use [GitHub private vulnerability reporting](https://github.com/ulda-io/ulda-auth/security/advisories/new) when it is enabled for the repository.

Include the affected package version, environment, expected and observed behavior, impact, and a minimal reproduction using synthetic data. Do not include live passwords, keys, origins, tokens, decrypted catalogs or customer data. Do not disclose an unpatched vulnerability in a public issue.

This policy covers the client SDK. Report issues in independently maintained dependencies to their maintainers as appropriate.

## Protected data and visible metadata

The SDK encrypts application JSON, the full ULDA origin, resource tokens, and the master's catalog of content names and secrets before sending them to the server. Public snapshots expose copies of application JSON, not the internal catalog or origin.

The server can see resource IDs, public witnesses, the container header, salts, nonces, ciphertext lengths, access timing and which resources are requested or changed together. Records contain no explicit master/content label, but traffic patterns and the public X/S mode can reveal relationships. This is not a traffic-analysis-resistant protocol.

HTTPS protects the connection to the selected server. An ID identifies a resource; it is not a password or authorization credential. The compatible storage model permits reading ciphertext by ID.

## Cryptographic profile

| Component | Profile |
|---|---|
| Resource encryption | AES-256-GCM, random 96-bit nonce per encryption, 128-bit authentication tag |
| Master key | PBKDF2-HMAC-SHA-256, 600,000 iterations, random 16-byte salt |
| Content key | HKDF-SHA-256 from an independent random 32-byte secret and random 16-byte salt |
| AES keys | Non-extractable Web Crypto CryptoKey objects |
| ULDA chain | Core compactV1, SHA-256, N=5, 256-bit origin blocks, X or S mode |
| Container | Version 2; authenticated header and complete witness |

The encryption key and ULDA origin serve different purposes. The witness supports chain validation; holders of the encryption key authenticate the payload. A server without that key cannot verify the AES-GCM tag.

The SDK checks the authenticated container, resource identity token, mode and equality of `sign(origin)` with the received witness. The exact container and additional authenticated data are specified in the [protocol](docs/PROTOCOL.md).

ULDA intentionally exposes its oldest origin block in a public witness. The full origin is never sent in plaintext; perpetual secrecy of every individual block is not a property of the core.

A party that obtains an encrypted master can attempt offline password guessing. Use a strong password. The fixed KDF cost slows guessing but does not make a weak password safe.

## Trust model

The SDK verifies authenticity and consistency relative to state it has already accepted. It does not prove that the server has supplied the globally latest state.

- **First open:** the client has no independently persisted witness or resource token. It trusts the selected server to return the requested master. The database ID is assigned after encryption and is not cryptographically bound into that initial container. Substitution with another valid master encrypted under the same password is not fully prevented at first open.
- **Live changes:** accepted updates must link to the known chain under the core's transition rules. The client may bridge a delayed ACK using exact candidates it actually prepared and sent.
- **Refresh and reconnect:** an authenticated newer snapshot may be accepted without the missing intermediate chain history. Mode and token must match the known resource; older states and different bytes at the same age are rejected.
- **New session:** there is no durable age anchor across closing the SDK or restarting the application. An old valid encrypted snapshot may therefore be indistinguishable from the latest one.
- **Deletion:** `Changed.deleted` is a trusted server statement, not a cryptographic tombstone. It removes the local resource; deleting the master closes the context.
- **Storage:** the server must validate witnesses and commit each write batch atomically. It must distinguish a definite rejection from an uncertain outcome.

A malicious or compromised server can withhold, corrupt or delete records, misreport deletion, and deny service. It can also hide a newer valid version. Client encryption does not provide server availability, access control or an audit log.

Anyone given the master password and ID can obtain the catalog and its content secrets. The SDK does not implement per-user roles, key revocation, password rotation or recovery of forgotten master credentials.

## Invalid input and integrity failures

Incoming records are checked for exact fields, canonical IDs, binary types, size limits and the supported canonical core profile. Binary views preserve their bounds; payloads are copied at protocol boundaries.

JSON validation does not invoke getters or custom `toJSON` methods. Cycles, accessors, non-JSON values and custom prototypes are rejected. Own properties such as `__proto__` are handled as data rather than prototype mutations.

A mixed incoming event is verified before publishing its known resource updates or applying deletions. A failed verification preserves the last verified snapshot and blocks further writes. A read started before a new integrity fault cannot clear that fault.

The retained snapshot may be stale. A successful explicit refresh can restore normal operation only when pending uncertain operations permit it. The SDK does not repair, delete or recreate a resource automatically in response to a bad packet.

## Writes and delivery

Create, Update and Delete use volatile Socket.IO events with an ACK deadline. Volatile delivery is not a transaction guarantee. The database commit and acknowledgement delivery are separate steps.

A missing or malformed success ACK after a write results in `UNKNOWN_OUTCOME`. Never treat that error as proof of rollback or automatically retry the write. A lost Create ACK can leave a resource whose ID the client never learned.

Creating or recovering content reserves a new resource before the separate atomic content/catalog update. Unreferenced encrypted records may remain after failure. [Content recovery](docs/RECOVERY.md) preserves the old resource because other catalogs may still reference it.

## Client memory and application responsibilities

Private fields and non-extractable keys are API boundaries, not isolation from code controlling the page or process. Plaintext and origin bytes must be available to JavaScript while the SDK is using them. XSS, malicious dependencies, debugging access and a compromised operating system can defeat client-side secrecy.

The SDK does not persist secrets in localStorage, IndexedDB or files. It wipes owned temporary byte buffers where possible and releases private state during `close()`. JavaScript strings, garbage collection, native crypto operations and copies held by the application prevent a guarantee of complete memory erasure.

The application is responsible for:

- its trusted endpoint, HTTPS deployment and dependency supply chain;
- password input, password quality, UI locking and clearing its own references;
- XSS prevention and control of scripts running in the same context;
- storing and presenting master IDs;
- its own copies of decrypted data and any telemetry or crash reports;
- authorization and abuse controls required beyond the SDK's encrypted storage model.

See [Secret lifecycle](docs/SECRET_LIFECYCLE.md) for allocation and cleanup behavior.

## Resource and diagnostic limits

The SDK bounds JSON sizes, queues, batches and binary reconstruction. See the [manifest](MANIFEST.md) for exact limits. Parser checks do not impose a total memory limit on the browser or Node process: the runtime may have allocated a frame before validation.

Large-operation frames contain ciphertext and public witnesses only. Framing does not change the encrypted container or its authentication. A compatible server must bound staged bytes, expire abandoned uploads, validate every candidate before one atomic commit, and keep an accepted commit's reservations until completion. The client does not expose a partial assembled Changed event or a partially checked catalog. Temporary transfer tokens do not add replay protection or resolve a lost Commit ACK. Larger catalogs increase client memory and processing costs despite bounded network frames.

SDK diagnostics contain fixed event codes, IDs, counts, sizes and timings. They omit plaintext, content names, credentials, full origins and raw packets. Server error strings are mapped to fixed local errors. IDs and access patterns can still be sensitive metadata; protect application logs accordingly.

The test reporter and local secret scanner reduce accidental disclosure during development. They do not sandbox arbitrary code or prove the absence of all secrets.
