# Socket protocol

This specification describes the binary Socket.IO contract used by ULDA Auth. It distinguishes server-visible records from the encrypted data interpreted only by clients.

## Connection and delivery

Each SDK instance opens one Socket.IO connection using WebSocket transport. Use HTTPS outside an explicitly allowed local development connection.

Request bodies contain no application requestId, sessionId or watch flag. Socket.IO's callback ACK identifies the request being answered. There are no public content names, passwords, origins or master/content labels in CRUD bodies.

Create, Update and Delete are sent as volatile events. Hello, Read and session.close use ordinary emit on an active connection. Every request has an ACK deadline. Volatile events can be dropped; they do not guarantee atomicity or delivery. Socket.IO write retries and its own reconnect loop are disabled; the SDK owns bounded reconnection.

## Events

| Event | Request body | Successful ACK |
|---|---|---|
| `ulda:hello` | `{}` | `{ ok: true }` |
| `ulda:read` | `["101", "102"]` | `{ ok: true, data: [record, ...] }` |
| `ulda:create` | `[{ witness, payload }, ...]` | `{ ok: true, data: ["101", ...] }` |
| `ulda:update` | `[{ id, witness, payload }, ...]` | `{ ok: true }` |
| `ulda:delete` | Removal entries `{ id, witness }` and optional replacement entries `{ id, witness, payload }` | `{ ok: true }` |
| `ulda:session.close` | `{}` | `{ ok: true }` |

All resource requests use arrays, including a Read of one master. Arrays are nonempty and contain at most 64 entries. Repeated IDs are rejected.

Create returns one unique ID per submitted entry, in request order. Read returns exactly one record per requested ID; response order is not significant. Update/Delete ACK the entire submitted batch and do not repeat the IDs.

Server push:

~~~js
{
  updated: [{ id, witness, payload }],
  deleted: ['103']
}
~~~

The event name is `ulda:changed`. It does not require an ACK. Either group may be omitted, but the event must contain at least one ID and at most 64 total IDs. Duplicate IDs and IDs appearing in both groups are rejected.

## Server-visible record

~~~js
{
  id: '101',
  witness: witnessBytes, // Uint8Array / binary attachment
  payload: payloadBytes // Encrypted container / binary attachment
}
~~~

- `id` is a decimal string, 1–40 digits with no leading zero.
- `witness` is the complete canonical compactV1 core packet: SHA-256, N=5, X/S, 256-bit origin blocks, uint32 age.
- `payload` is an authenticated encrypted SDK container, not application JSON.

Create has no ID because the server assigns it. The server stores no resource role, content name, password or parent reference. The encrypted catalog is a client concern.

The client submits only the candidate witness on mutation. The server compares it against the currently stored witness. It must not accept a client-provided replacement for its current validation anchor.

## Binary representation

The SDK emits Uint8Array fields. Incoming Buffer/Uint8Array and ArrayBuffer values are normalized using their actual view bounds. Strings, numeric arrays, serialized Buffer objects, SharedArrayBuffer and empty or oversized binary fields are rejected.

Socket.IO carries an event header with binary placeholders and separate attachments. Do not JSON.stringify the event body or wrap witness/payload in Base64. This is Socket.IO's binary protocol, not a single custom raw WebSocket frame.

The decoder bounds reconstruction to:

- 128 binary attachments;
- 8,388,608 combined binary bytes;
- 1,100,000 bytes per attachment;
- 65,536 UTF-8 bytes for the text header.

The server must configure compatible parser/transport limits and still validate complete application messages. These checks bound retained protocol input, not all allocations in the host process.

## Error ACK

~~~js
{ ok: false, error: 'conflict', id: '101' }
~~~

`id` is optional. No additional fields are accepted.

| Server error | SDK code |
|---|---|
| conflict | CONFLICT |
| invalid_witness | CONFLICT |
| not_found | NOT_FOUND |
| too_large | LIMIT |
| unsupported_profile | UNSUPPORTED_PROFILE |
| Other error strings, including invalid_request/storage_error | SERVER_ERROR |

Server-provided text and stack traces are not forwarded to the application. A missing or malformed success ACK for a sent write becomes UNKNOWN_OUTCOME: a database commit may already exist.

There is no extra client receipt for Create, durable operation-status endpoint or automatic lookup for a lost generated ID. A Create with a lost ACK may leave an unreachable resource from that client's perspective.

## Encrypted container v2

| Byte offset | Length | Meaning |
|---|---|---|
| 0 | 4 | Magic/version: 55 4c 44 02 |
| 4 | 16 | Resource salt |
| 20 | 12 | AES-GCM nonce |
| 32 | Remaining bytes | Ciphertext followed by the 16-byte authentication tag |

Container overhead is 48 bytes. Every encryption uses a fresh random nonce. The salt belongs to the resource's derived key and is carried with its state.

~~~text
AAD = UTF8("ULDA-SDK/container/v2\0")
      || payload[0:20]
      || completeWitnessBytes
~~~

`\0` is a single zero byte. AES-GCM uses a 256-bit key and a 128-bit tag. The nonce is the AES-GCM IV; the authenticated header is the magic plus salt.

Master keys use PBKDF2-HMAC-SHA-256 with 600000 iterations and the container salt. Content keys use HKDF-SHA-256 with an independent 32-byte secret, that content's salt, and `UTF8("ULDA-SDK/content-key/v2")` as info. AES keys are non-extractable.

The container header does not encode the key-derivation role. The client knows whether it is opening its master or a content entry from its local context.

After decryption only, the plaintext object is:

~~~text
{
  token: Base64URL(32 random bytes),
  origin: Base64URL(complete secret origin packet),
  data: application JSON or encrypted-catalog data
}
~~~

The master's private data has this shape:

~~~text
{
  contents: [
    { id, name, key, token }
  ]
}
~~~

`key` is the Base64URL content secret. Names, keys, tokens and the full origin never become plaintext fields in a socket request. Base64URL here is inside the encrypted JSON; it is not a wire wrapper.

Clients verify AES-GCM, exact private fields, the expected identity token where known, the allowed mode/profile and `sign(origin) === witness`. Container v1 is rejected; automatic migration is not part of this protocol.

No explicit role marker does not imply indistinguishability: lengths, timing, grouped IDs and the public mode still reveal information. In particular, masters are always X.

## Atomic server operations

### Create

Validate the batch, store each encrypted record and assign IDs. A successful response must represent the committed batch. Subscribe the live initiating connection before ACK.

For content creation, the SDK initially stores encrypted null data. The following content/catalog Update is a separate commit; a crash between them may leave a reserved resource.

### Update

Validate every candidate against the current stored witness under the same concurrency protection used for commit. Under this profile, X permits a one-step transition; S permits the core's bounded 1–4-step window.

Commit the entire batch or none of it. Replace witness and payload together. A stale candidate fails with conflict rather than overwriting another writer.

The server verifies public witness transitions, not the AES-GCM tag: it has no decryption key.

### Delete

At least one entry must omit payload; that entry is a physical deletion proof. Entries with payload are updates in the same transaction. All IDs must be unique.

Validate all witnesses first, then atomically apply all deletions and updates. Deleting content plus updating its master therefore uses:

~~~text
[
  { id: contentId, witness: nextContentWitness },
  { id: masterId, witness: nextMasterWitness, payload: nextEncryptedMaster }
]
~~~

The body carries no master role. The server interprets the entries only by the presence of payload. SuperDelete sends deletion proofs for all listed contents and the master in one batch.

## Subscriptions and ordering

Successful Read/Create/Update registers the live connection for the affected IDs, without duplicate subscription entries. Read returns a coherent record snapshot and establishes its subscription before a later update can be missed. Enqueue its response before subsequent Changed notifications for that state.

Commit before ACK and Changed. The initiating socket receives its own ACK and does not receive an echo Changed for that command. Other sockets, including another device for the same user, remain eligible.

Group affected subscribed resources into a Changed event for each recipient. A subscription index keyed by resource ID and a reverse index keyed by connection allow targeted delivery and cleanup; the wire does not expose or require those data structures.

Disconnect/session.close removes subscriptions for that connection. Reconnect uses new reads rather than restoring a persisted socket session or replaying missed Changed events. An operation completing after disconnection must not recreate a subscription for the closed connection.

## Client application of responses

After its own valid ACK, the SDK accepts its already prepared local candidate. It does not reread solely to subscribe or repeat encryption for that acknowledged state.

An incoming update can arrive before a delayed ACK. The SDK may validate a path through its own exact sent candidates. An older ACK must not roll back a newer verified state, and a Changed event does not resolve the promise of a write whose ACK was lost.

The client verifies a complete staged incoming set before publishing known updates/deletions. New content IDs discovered in an authenticated master require subsequent reads and verification. Unknown records cannot be decrypted or exposed without catalog credentials.

Live Changed requires valid lineage. Explicit refresh/reconnect may accept a newer authenticated snapshot without intermediate history. Deleted IDs are trusted server statements. See [Security](../SECURITY.md) for first-open, rollback and deletion assumptions.

## Read splitting and compatibility

Oversized Read requests may be split into smaller arrays. Each reply must still match its request. The SDK publishes the combined snapshot only after all required records pass verification. Separate reads do not provide one global database snapshot across concurrent changes.

Atomic Update/Delete batches are never split. The supported limits are in the [manifest](../MANIFEST.md).

No operation IDs, offline replay, ACL fields, CRDT merge or password-reset protocol are supplied by this contract. A compatible implementation in another language must preserve the byte format, validation rules, atomicity and failure semantics.

## Optional diagnostics

A development server may emit `ulda:diagnostic` with `{ action, step, ids, count }`. This is outside CRUD and requires no ACK. The standard transport reads it only when configured with `diagnostics: true`.

Only recognized action/step codes and bounded metadata are accepted. Invalid diagnostic input is ignored. Trace timestamps, request sequence numbers and durations are local diagnostics, not fields added to CRUD or server resource records.
