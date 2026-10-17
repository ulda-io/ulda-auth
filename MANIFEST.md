# ULDA Auth Manifest

This manifest defines the SDK's architecture, data model and supported contract. Usage examples are in the [guide](docs/GUIDE.md); security assumptions are in [SECURITY.md](SECURITY.md).

## Purpose

ULDA Auth is a JavaScript client SDK for encrypted JSON resources. It manages an encrypted catalog, a separate ULDA chain per resource, client-side encryption, write queues, transport, change delivery and connection recovery.

It uses the separately licensed `ulda-core@1.0.1`. The application supplies its endpoint, master ID and password. The storage server, account UI and application authorization are separate components.

## Components

| Component | Responsibility |
|---|---|
| Client | Catalog, resource lifecycle, validated local state and event delivery |
| Crypto | Password/content key derivation and authenticated encryption |
| Core adapter | Supported ULDA profile, origin creation, chain advancement and witness verification |
| Protocol | Exact packet shapes, size validation and opaque outgoing handles |
| Transport | One Socket.IO WebSocket connection, ACKs and incoming encrypted records |
| Queues | Per-resource X/S writes and serialized catalog operations |
| Reconnect | Bounded connection/Hello/read retries, without write replay |
| References | Explicit access to application JSON through get/update/delete |

`src/` contains the JavaScript implementation. `dist/ulda-library.js` is the generated standalone ESM bundle. `types/index.d.ts` describes the same API for editors and TypeScript; it is not another runtime implementation.

## Resource model

A master is an encrypted catalog containing content IDs, names, secrets and identity tokens. It always uses X. Content stores application JSON and uses X by default, or S when chosen at creation.

A server record contains only `id`, `witness` and encrypted `payload`. It has no explicit master/content role or parent field. The client interprets its decrypted catalog; the server can still observe access patterns and public witness metadata.

Public snapshots expose application JSON, not internal catalog credentials or origins.

## Supported profile

| Property | Value |
|---|---|
| Core format | canonical compactV1 |
| Core hash | SHA-256 |
| Chain width | N=5 |
| Origin block size | 256 bits |
| Modes | X and S |
| Age | uint32; advancing past the maximum is rejected |
| Payload container | SDK version 2 |
| Encryption | AES-256-GCM, 96-bit nonce, 128-bit tag |
| Master KDF | PBKDF2-HMAC-SHA-256, 600000 iterations, 16-byte salt |
| Content KDF | HKDF-SHA-256, independent 32-byte secret, 16-byte salt |
| AES key export | Disabled |

The header and full witness are authenticated with the encrypted payload. The [protocol specification](docs/PROTOCOL.md) defines byte layout and domain separation.

## Operational contract

One SDK instance uses one connection. Successful Read/Create/Update subscribes it before ACK. Its own write is confirmed by ACK; other subscribers receive Changed. Disconnect removes subscriptions.

Content creation reserves an ID, then atomically updates the content and master together. The two commits are not one distributed transaction. Update batches and mixed Delete/Update batches must be atomic at the compatible server.

Conflicting writers do not merge. X permits one pending write per resource. S permits a bounded local chain of pending writes. Every operation retains its own ACK/outcome.

Writes are volatile and are not replayed automatically. Missing or invalid success ACKs produce UNKNOWN_OUTCOME. Explicit refresh may resolve working state without changing the original rejected promise.

Live updates require a valid chain transition. Full refresh/reconnect may accept an authenticated newer snapshot without missing intermediate history. The server's selection of that snapshot and its deletion notifications are trusted. Invalid input preserves verified local state and blocks normal writes.

Explicit content recovery creates a new resource from a confirmed local copy, replaces one catalog entry and keeps the old resource.

## Interfaces

Exports: `Ulda`, `SocketIoTransport` and `UldaError`.

The client provides registration/opening, CRUD, nested references, local snapshots, refresh, reconnect, explicit recovery, close, and status/change/error/trace/reconnect events. Signatures and error behavior are defined in [API.md](docs/API.md).

## Limits

| Limit | Value |
|---|---|
| Application JSON per resource | 1,048,576 UTF-8 bytes |
| JSON nesting depth | 48 |
| Visited JSON nodes | 40,000 |
| Content entries per master | No fixed count; catalog bytes and server budgets apply |
| Items per ordinary protocol batch/event or transfer append | 64 |
| Reassembled encrypted resource | 67,108,864 bytes |
| Logical transfer / queued incoming binary budget | 134,217,728 bytes |
| Large-resource fragment | 1,048,576 bytes |
| Combined witness/payload bytes per message | 8,388,608 |
| Binary attachments per Socket.IO packet | 128 |
| Bytes per binary attachment | 1,100,000 |
| Decoder text header | 65,536 UTF-8 bytes |
| Queued incoming handlers | 8 |
| Waiting/pending jobs per relevant outgoing queue | 128 |
| Content name | 1–256 UTF-16 code units |
| Master password input | 1–1024 UTF-16 code units |

Container overhead and catalog metadata consume additional space; not every theoretical maximum can necessarily be combined in one batch. The 40,000-node and 1 MiB JSON limits apply to application content; the private catalog uses the resource byte budget (with 4,096 bytes reserved for envelope overhead) and a byte-derived node bound. JSON depth remains bounded in both cases.

The SDK reads catalog contents in groups of at most 64 IDs and reduces the group when a server explicitly rejects its size. Large ciphertext is reassembled from fragments. Large atomic writes use a staged transfer followed by one commit, never separate partial mutations. Logical transfer accounting includes 256 bytes per item. This framing requires a server implementing the [transfer extension](docs/PROTOCOL.md#large-operation-transfer). Server subscription, Router, byte and timeout budgets can reject an otherwise valid catalog or operation.

Catalogs are loaded eagerly: all required content is verified before a new snapshot is published. There is no lazy loading or nested-master API. Removing the fixed entry count does not promise unlimited memory, storage or operation size.

## Environment and distribution

Node.js 22 or later; browser ES2022 with Web Crypto and WebSocket in a secure context. HTTPS endpoints are required except explicit HTTP loopback development.

The normal ESM entry uses npm dependencies. The browser ESM bundles them and includes their license notices. The package contains runtime modules, declarations, the browser bundle and user documentation. Test fixtures and maintainer tooling are repository-only.

Private fields, non-extractable keys and best-effort cleanup do not isolate secrets from hostile code controlling the same page or process. [Secret lifecycle](docs/SECRET_LIFECYCLE.md) defines cleanup responsibilities.

The [ULDA Library Community Source License](LICENSE.md) governs the SDK. Dependencies retain their own licenses; the core and server have separate scopes.
