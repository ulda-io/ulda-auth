# ULDA Library Manifest

Revision: 2026-10-10. Package: `ulda-auth@1.0.0`, prepared release, not yet published.
Target: 1.0.0 after the remaining release checks. This document describes the SDK's current
implementation; it does not declare the package or the main backend production-ready.

## Purpose and boundaries

ULDA Library is a JavaScript client SDK for encrypted JSON resources, an encrypted catalog,
per-resource ULDA state, local write queues, and Socket.IO transport. It uses the separately
licensed, pinned `ulda-core@1.0.1` npm dependency; it does not replace or modify the core.

The application supplies its server endpoint and the user's master ID/password. The SDK does not
provide user identity, account permissions, login aliases, a production storage server, automatic
repair/recreation of missing files, offline write replay, or protection from a compromised runtime.

## Resources and cryptography

- Server records contain only `id`, `witness`, `payload`. No public master/content discriminator.
- Master is a locally interpreted catalog, always X, containing content IDs, names, keys and tokens.
  Each content has its own chain and key; mode X is default and S is explicit.
- Profile: compactV1, SHA-256, N=5, 256-bit origin blocks. Per-resource age is bounded by uint32.
- AES-256-GCM with a fresh random 96-bit nonce and 128-bit tag. Master key: PBKDF2-SHA-256,
  600000 iterations, random 16-byte salt. Content key: HKDF-SHA-256 from an independent random
  256-bit secret and random 16-byte salt. Derived CryptoKeys are non-extractable.
- Container v2 encrypts JSON, full origin and resource token. AAD binds the container header and
  full public witness; clients check `sign(origin) == witness`. A wire handle is produced only
  after successful encryption. Ciphertext and witness travel as binary attachments.
- ID, witness, salt, nonce, ciphertext length and traffic relationships are visible to the server.
  Ordinary strings/JSON in JS memory are not hardware-isolated or guaranteed to be securely erased.

Details: [SECURITY.md](SECURITY.md), [PROTOCOL.md](docs/PROTOCOL.md).

## Public API and state

Exports: `Ulda`, `SocketIoTransport`, `UldaError`.

`register`, `connect`, `add`, `update`, `set`, `remove`, `delete`, `superDelete`, `refresh`,
`reconnect`, `recoverContent`, `close`, `snapshot`, `value`, `ref`, `data`, `ready`, `status`, and `on` form the
current SDK surface. Nested references provide `get/update/delete/field/toJSON`; they are bound
to their original content ID and context, not only to a reusable name. Public snapshots are
independent copies of application JSON and contain no internal catalog keys or origin.

Statuses: connecting, ready, open, disconnected, reconnecting, needsResync, closed.
Events: change, status, error, trace, reconnect. Diagnostic records contain fixed codes,
identifiers, counts and timings, not private contents or raw packets.

`close()` invalidates references, aborts SDK waits, wipes known owned origin buffers and releases
the working catalog/keys/queues before waiting for the best-effort session.close ACK. It does not
undo an already committed server write or erase copies already obtained by the application.
See [the lifecycle contract](docs/SECRET_LIFECYCLE.md).

## Transport, concurrency and recovery

One Socket.IO connection per SDK; `ulda:hello/read/create/update/delete/session.close` use ACKs,
and `ulda:changed` delivers server updates. Successful Create/Read/Update subscribe the current
connection to affected IDs before ACK. Author socket receives its own ACK, not an echo Changed.
Other tabs/devices remain subscribers. Disconnect discards that connection's subscriptions.

Create content reserves an encrypted resource and receives an ID, then a separate atomic Update
commits content plus its encrypted catalog entry. These are two commits, not a distributed
transaction. Update batches and mixed Delete/Update are atomic at the compatible server.
The first valid writer wins; later conflicting candidates fail. Mode S queues are bounded by
the core's allowed window; individual promises correspond to their own ACKs.

Writes are volatile and never automatically replayed. A missing or invalid success ACK gives
UNKNOWN_OUTCOME. Lost Create master ID is not automatically recoverable. A later read may resolve
the working state but cannot retroactively turn the original operation promise into success.

After a non-intentional disconnect from a previously established connection, a bounded SDK cycle
reconnects, sends Hello and reads the resources again. Default: up to 5 attempts in 30 seconds,
delays 500–5000 ms with 20% jitter; all are configurable. First failed ready is not auto-retried.
Manual reconnect joins the same cycle; close cancels it. No second Socket.IO retry loop is enabled.

## Trust and invalid data

The SDK checks cryptographic validity, resource token/mode and no rollback relative to the current
in-memory anchor. Ordinary Changed requires an allowed core transition. Full refresh/reconnect
accepts an authenticated newer snapshot without the missed history, trusting the server's version
selection. First login has no independent persisted anchor; latest-version proof is not supplied.

Deletion notifications are trusted server statements. Invalid known updates in a mixed event are
rejected before its deletions are applied. Failed read/verification preserves the last verified
snapshot and blocks writes; recovery does not delete/recreate data automatically.

## Limits and distribution

Node >=22 for the tested harness; browser ESM target ES2022, Web Crypto and native WebSocket.
HTTPS is required, except explicit localhost HTTP for tests. Browser support has not been certified
through a target-browser matrix. The bundled ESM is exercised in Node using native WebSocket/Web Crypto.

Limits: 1 MiB JSON/resource, 63 content/master, 64 resources/batch, 8 MiB binary fields/message,
128 attachments, 1.1 MB/attachment, 64 KiB decoder header, JSON depth 48 and 40000 nodes,
8 pending incoming handlers and 128 intents/waits per relevant outgoing queue.
Only oversized Read is split into smaller groups; atomic writes are not split.

The SDK has been tested with its in-memory fixture and the real ULDA Server/PostgreSQL.
The fixture is not a production backend. Core, backend, SDK and application have separate release scopes.

[LICENSE.md](LICENSE.md) governs the SDK under the ULDA Library Community Source License 1.0.
Dependencies retain their own terms. The license version is independent of the package version.
Build output carries SDK/dependency notices. No publication is performed by building the SDK.

Remaining gates: final candidate/backend/browser/load acceptance, independent security review,
owner review of release/legal texts and enabling the official repository/security reporting.
[RELEASE.md](docs/RELEASE.md) describes packaging and evidence boundaries.

Exports: ESM source via ulda-auth, standalone ESM via ulda-auth/browser, and package.json.
TypeScript declarations are included. Tests, fixture server, demos, tools and local archives
are repository-only. The runtime code, cryptographic profile and wire were not changed for packaging.
