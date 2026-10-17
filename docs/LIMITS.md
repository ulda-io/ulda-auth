# Limits and capacity planning

This page describes ULDA Auth 1.1.0. A catalog has no fixed content-entry count cap. Operations still have byte, memory, queue and time limits. These limits protect both endpoints; they are not throughput guarantees.

## SDK bounds

| Boundary | Limit |
|---|---|
| Application JSON per content | 1,048,576 UTF-8 bytes; depth 48; 40,000 visited nodes |
| Private catalog JSON | 67,104,768 UTF-8 bytes; depth 48 and a byte-derived node bound |
| Encrypted resource after reassembly | 67,108,864 bytes (64 MiB) |
| One logical transfer | 134,217,728 bytes (128 MiB), including 256 bytes of accounting per item |
| Queued incoming binary data | 128 MiB |
| Ordinary Read / mutation batch / transfer append | At most 64 items |
| Ordinary message, combined witness and payload bytes | 8,388,608 bytes (8 MiB) |
| Binary attachments per packet | 128; each at most 1,100,000 bytes |
| Large-resource fragment | 1,048,576 bytes (1 MiB) |
| Decoder text header | 65,536 UTF-8 bytes |
| Queued incoming handlers | 8 |
| Jobs per relevant outgoing queue | 128 |
| Content name | 1–256 UTF-16 code units |
| Master password input | 1–1024 UTF-16 code units |
| Resource ID accepted by SDK | Positive decimal string of 1–40 digits, without leading zeroes |
| Chain age | Unsigned 32-bit integer; no automatic chain rotation at exhaustion |

Container overhead, witnesses and catalog metadata consume space. The application JSON maximum does not describe the size of its encrypted wire representation. Bounds are checked together: reaching one maximum does not imply that every other maximum remains available.

The standard PostgreSQL server uses positive BIGINT IDs, whose maximum is `9223372036854775807`. The SDK's wider decimal-string validation does not expand that database range.

These SDK bounds are currently implementation constants, not constructor options. Changing a server's limits alone does not change the SDK's bounds. Hello does not negotiate these budgets.

## Reading a large catalog

1. Read the master by ID. Reassemble large ciphertext when necessary, then authenticate and decrypt locally.
2. Extract content IDs and private credentials locally. Names and credentials never appear as plaintext request fields.
3. Read content in groups of at most 64 IDs. Each ordinary request has one ACK containing its result array. Large resources use the transfer extension.
4. If the server explicitly rejects the size, reduce the read group. Temporary server saturation is a different error and does not trigger recursive splitting or automatic request replay.
5. Verify every required result before replacing the visible local context. A bad final batch must not publish the earlier batches as a partially refreshed catalog.

Reads subscribe the current connection to each resource. There is no fixed 63-content cap, no single request containing every ID regardless of size, and no durable server-side download cursor. A failed refresh preserves the last verified local context; the application handles the error and can explicitly refresh again. Separate Read batches are not one database snapshot: concurrent writers can change resources between reads.

Loading is eager. All required content is held locally; there is no lazy-loading or nested-master API. Ten thousand contents of 1 MiB each already represent about 10 GiB of plaintext before temporary copies and encryption buffers. A catalog with many small entries and a catalog with the same number of large contents have very different memory costs.

## Mutations and atomicity

Changing one field re-encrypts the entire content. Adding, deleting or replacing a catalog link also re-encrypts the entire master. Catalog growth therefore increases the work and traffic of catalog mutations.

Large atomic mutations are transmitted as `begin`, `append` / `part`, then `commit`. Staging does not write partial resource changes or hold an open SQL transaction between packets. The server checks the complete operation and commits all resource changes in one transaction. A failed operation must not commit a subset. An expired staging area must be sent again only as a new, explicitly initiated operation; an uncertain commit must not be replayed automatically.

`add()` reserves a new ID in one Create, then commits the new content and master together in a second operation. The entire method is **not** one transaction. Interruption can leave an unreferenced resource; there is no automatic orphan garbage collector. `recoverContent()` similarly replaces one master link and intentionally preserves the old resource.

`delete()` and `superDelete()` first refresh and verify the current required resources. Missing or damaged content can prevent deletion. A large `superDelete()` remains atomic, but must fit the server's total operation, lock and staging budgets. It is not a sequence of independently committed deletion chunks.

X mode permits one pending write per resource. S mode prepares a bounded sequence of local steps: with N=5 the next age must remain less than 5 steps ahead of the confirmed age (at most 4 ahead). S does not merge changes from different clients. Conflicting writes require application handling.

## Server budgets also apply

The following are defaults of the companion single-process ULDA server implementing the transfer extension. Operators can configure server admission limits; confirm the actual deployment configuration. Consult that server's `docs/ADMISSION_LIMITS.md` for the complete list.

| Boundary | Default / consequence |
|---|---|
| Connections | 1,000; configurable admission ceiling, not measured capacity |
| Subscription edges | 100,000 globally; 32,768 per connection |
| Router keys | 32,768 globally; at most 100 waiting jobs per key |
| Incoming copied bytes | 64 MiB globally |
| Active read reservations | 256 MiB globally |
| Outbound bytes | 64 MiB globally; 16 MiB per connection |
| Staging | 256 MiB globally; accounts for `3 × binary bytes + 256 × item count` |
| One resource / logical operation | 64 MiB / 128 MiB |
| Transfer lifetime | 60 seconds absolute by default; not renewed indefinitely by progress |
| Active transfers | One staged upload and one large read per connection |
| Waiting commands | 64 per connection |
| Command rate | 1,000/s with burst 2,000 per decoder; not an authentication or per-IP quota |

Examples of interacting limits:

- A fresh connection needs one subscription for the master and one per content. With the default per-connection ceiling, 32,767 contents is the theoretical maximum for that one connection, before other constraints. This is a **server admission consequence**, not a new SDK catalog-count constant.
- One hundred connections opening 10,000 contents each need over one million subscription edges, exceeding the default global 100,000 budget.
- Deleting all resources requires Router capacity for the whole set. Existing unrelated work can reduce available capacity. Transmission in fragments does not remove this requirement.
- Staging's copy accounting can reject an operation below the logical 128 MiB maximum. Those two maxima are not interchangeable.
- A valid encrypted resource can exceed the per-connection outbound queue during Changed fan-out. The server can disconnect a slow or over-budget recipient; reconnect and a verified read recover its state. Changed is not a durable message log.
- The server reserves read memory before database work. Temporary contention waits in a bounded FIFO (default 5 seconds). Exhaustion returns an error; the SDK does not turn saturation into more and smaller requests. A read that cannot fit at all is a size rejection.

Subscriptions are looked up by resource and connection. The current server uses two Maps containing arrays; membership checks and removal scan the relevant list. This avoids scanning every connected client for every update, but fan-out and large subscriber lists still have a cost.

## Timeouts and recovery

The default SDK timeout is 10 seconds per awaited transport operation, configurable from 50 to 60,000 ms. It is not a deadline for the entire multi-request `connect()` or `superDelete()`. Increasing it does not increase server transfer lifetime, SQL deadlines or memory budgets.

Automatic reconnect defaults to at most five attempts within 30 seconds, with delays from 500 to 5,000 ms and jitter. It rereads and verifies state; it does not replay writes. Initial connection failure is not automatically retried in the same way as a lost established connection.

A lost or invalid write ACK can mean `UNKNOWN_OUTCOME`: the server may have committed. Volatile emission is not a delivery guarantee. A lost Create ACK has no built-in ID-recovery service. Save master IDs through the application and handle unknown outcomes explicitly; see [recovery](RECOVERY.md) and [API errors](API.md).

Refresh/reconnect may accept a newer authenticated snapshot without proving every missed chain transition. The server's ID-only deletion notifications are trusted. Secrets are private to SDK internals by API design, but this does not protect them against malicious code controlling the same page or process. See [security](../SECURITY.md).

## Compatibility and upgrades

Version 1.1.0 preserves public method signatures, encrypted container format and the core dependency. It adds bounded multi-request reading and the large-operation transfer extension. A server must implement that extension for large resources or operations; upgrading the SDK alone is insufficient.

Version 1.0.1 and earlier enforce the old small-catalog bound and cannot open catalogs that exceed it. Upgrade the server and **all clients** before allowing catalogs to grow beyond old limits. There is no automatic catalog sharding or conversion into nested masters.

Capacity measurements apply to their stated hardware, payloads, concurrency and transport conditions. A successful small-content load test does not establish performance for large catalogs, registration KDFs, shared hot resources, high fan-out or WAN/TLS traffic.
