# API reference

Exports: `Ulda`, `SocketIoTransport` and `UldaError`. Both `ulda-auth` and `ulda-auth/browser` expose the same API. The browser entry includes its dependencies.

See the [usage guide](GUIDE.md) for complete workflows and [pipelines](PIPELINES.md) for internal steps.

## Values and identifiers

- Resource IDs are strings matching `[1-9][0-9]{0,39}`: 1–40 decimal digits, no leading zero.
- Content names are nonempty strings of at most 256 UTF-16 code units, unique within a master.
- Modes are `'X'` and `'S'`. The master is always X.
- Data may contain null, booleans, finite numbers, strings, dense arrays and plain objects, including null-prototype objects.
- Undefined, bigint, functions, symbols, Date, custom prototypes, accessors, sparse arrays and cycles are rejected. The validator does not invoke getters or `toJSON`. Special own property names are copied as data.
- A path is an array of strings or safe integer indices, at most 48 components. Array indices must be nonnegative existing indices. Intermediate path components must exist.

Data is defensively copied. Returned object copies may have a null prototype; use `Object.hasOwn` rather than inherited helpers.

## Constructor

~~~js
const ulda = new Ulda(endpoint, options);
~~~

The constructor begins connection establishment. The standard transport accepts HTTPS URLs without credentials, query or fragment. HTTP is allowed only for an explicit loopback development connection.

| Option | Default | Contract |
|---|---|---|
| `timeout` | 10000 | Integer milliseconds, 50–60000; used by the standard transport |
| `allowInsecureLocalhost` | false | Allows HTTP only for localhost, 127.0.0.1 or [::1] |
| `reconnect` | Default settings below | false disables automatic recovery; an object overrides settings |
| `transport` | New SocketIoTransport | An existing transport instance; its endpoint and transport options govern the connection |

Unknown top-level Ulda options are rejected. When injecting a transport, configure its timeout and endpoint when constructing it.

### Reconnect settings

| Setting | Default | Allowed values |
|---|---|---|
| `maxAttempts` | 5 | Integer 1–20 |
| `initialDelay` | 500 | Integer milliseconds, at least 10 and no greater than maxDelay |
| `maxDelay` | 5000 | Integer milliseconds, at most 60000 |
| `jitter` | 0.2 | Number from 0 to 1 |
| `budget` | 30000 | Integer milliseconds, 50–300000 |

Automatic recovery starts only after a previously established connection disconnects unintentionally. The first failed `ready` is not retried automatically. Explicit reconnect uses the same bounded recovery mechanism, even when automatic recovery is disabled.

## Properties and local reads

| Member | Result |
|---|---|
| `ready` | Promise<void> for connection and Hello; updated when explicit reconnect starts |
| `status` | Current status string |
| `data` | Reference tree for the open catalog |
| `contextGeneration` | Internal reference-generation number; not a server revision |
| `snapshot()` | Independent copy of all currently available content JSON, keyed by name |
| `value(name, path = [])` | Independent copy of a content value or nested value |
| `ref(name)` | Reference bound to the current content ID and session |
| `on(event, listener)` | A function that removes that local listener and returns whether it was removed |

These data reads require an open catalog but can read a retained snapshot while disconnected or in `needsResync`. They do not request network data and do not prove freshness.

### Status values

| Status | Meaning |
|---|---|
| `connecting` | Initial connection/Hello in progress |
| `ready` | Transport is ready, no master is open |
| `open` | A verified catalog is available; operation-specific guards still apply |
| `disconnected` | Transport is unavailable; a previously opened snapshot may remain readable |
| `reconnecting` | A bounded connection recovery cycle is running |
| `needsResync` | An integrity fault or unresolved state prevents normal writes |
| `closed` | Terminal state; use a new instance |

Use operation promises and `status` together. A transport-level ACK does not guarantee that every unrelated resource or pending operation is ready to write.

## Session methods

### register(password) → Promise<string>

Create a master and open its prepared local state after a valid Create ACK. Returns the assigned master ID. Password must be a nonempty string of at most 1024 UTF-16 code units. Its contents are not sent to the server.

The method awaits readiness and requires no open or opening master. It performs local key derivation, origin creation and encryption before Create. It does not reread its own successful Create.

If the request outcome is unknown, no successful master ID is returned. The server may hold an orphan resource. There is no ID-guessing or automatic Create retry.

### connect(masterId, password) → Promise<DataTree>

Open an existing master and its referenced content. Requires no existing/opening master. Password rules match `register`.

The master, catalog and required content are verified before the new session is published. Returns the same kind of reference tree as `ulda.data`. Wrong credentials or corrupted ciphertext can both produce `CRYPTO_FAILED`.

A new concurrent integrity fault prevents the older read from opening the context. An explicit new connect performs a new read.

### refresh() → Promise<DataTree>

Read and verify the open master and its contents, then replace the working snapshot as a set. Does not advance chains or issue writes. Successful reads restore server subscriptions.

Active writes or recovery work can cause `BUSY`. Failure preserves the previous verified snapshot. Success can still leave `status === 'needsResync'` if an uncertain operation is unresolved.

Refresh accepts a newer authenticated snapshot without requiring missing intermediate chain history; see [Security](../SECURITY.md).

### reconnect() → Promise<DataTree | undefined>

Reconnect, send Hello, and refresh if a master is open. Returns a data tree for an open catalog or undefined if only transport readiness is restored.

Concurrent calls join the existing cycle. Closing cancels it. Read/connect retries are bounded; writes are never replayed. Invalid data or an unresolved write can stop recovery rather than trigger another attempt.

### close() → Promise<void>

Close the instance. Repeated calls join the same close operation. Invalidates references, cancels SDK waits, releases private state, attempts a bounded session-close ACK if connected, then closes the transport.

It does not delete resources or reverse committed writes. Cleanup starts before waiting for the server. A late response cannot reopen the instance.

## Content methods

### add(name, value, mode = 'X') → Promise<AddResult>

Creates a content resource and adds one encrypted entry to the master.

~~~js
{ ok: true, name, subscriptionReady }
~~~

The name must not already exist. There is no fixed content-entry count limit in a master. Encrypted catalog bytes, operation bytes and the server's admission budgets still apply; see the [manifest](../MANIFEST.md#limits). Mode is fixed at creation.

The operation reserves an encrypted empty resource, then sends one atomic Update for the content and master. The reservation is a separate commit. `subscriptionReady` is the transport's connection state at completion, not a permanent delivery guarantee.

A retained known reservation may be continued explicitly on the same instance with the same input after conflict handling. A lost Create ID cannot be recovered that way. Normal methods are blocked when the catalog has an unresolved unknown outcome.

### update(name, value) → Promise<{ ok: true }>

Replace the entire content JSON. Equivalent to `set(name, [], value)`. Queued per resource; the returned promise belongs to that write's ACK.

### set(name, path, value) → Promise<{ ok: true }>

Replace a nested value, or the whole content when path is empty. An object field at the final component may be new; parents must already exist. Arrays support replacement at existing indices.

### remove(name, path) → Promise<{ ok: true }>

Remove an existing field or array element. Array elements are removed using splice semantics. An empty path is rejected; use `delete(name)` for the whole resource.

### delete(name) → Promise<{ ok: true }>

Refresh the catalog and content, then atomically delete the selected content and update the master without its entry. It requires no competing local operation and can return `BUSY`.

Physical deletion affects any other catalog that references the same ID. The server cannot discover those encrypted references. Fresh reads do not lock out other writers; the server's witness check still decides whether the final batch can commit.

### superDelete() → Promise<{ ok: true }>

Refresh and validate all referenced resources, delete the listed content and master in one atomic batch, then close the instance.

Invalid or missing required content can stop the operation before deletion. There is no forced deletion of an unreadable master/catalog through this method.

### recoverContent(name) → Promise<RecoveryResult>

Create a replacement from the last confirmed local copy, update one master entry, and preserve the old resource.

~~~js
{ ok: true, previousId, id, sourceAge, reconciled }
~~~

`sourceAge` belongs to the old chain. `reconciled` means this explicit call verified a previously uncertain recovery update; it does not change the result of an earlier rejected promise.

Requires a verified local source, a live connection and no competing local writes. A retained recovery plan blocks normal writes until resolved or closed. See [Recovery](RECOVERY.md) for all continuation rules.

## References

`ulda.ref(name)`, `ulda.data[name]` and `ulda.data.field(name)` address the same content.

| Member | Behavior |
|---|---|
| `get()` | Read an independent JSON copy |
| `toJSON()` | Same local read; used by explicit JSON serialization |
| `update(value)` | Update the addressed node |
| `delete()` | Remove the node; at content root, call ulda.delete |
| `field(key)` | Address a child with a dynamic or reserved name |
| `reference.key` / `reference[index]` | Address an ordinary child |

Reserved reference members: get, update, delete, field, toJSON and then. Access data with these names through `field`. At data-tree level, use `ref` or `data.field` for field, toJSON and then. Symbol properties and automatic `then` access are not data references.

Direct assignment, the JavaScript delete operator and property definition are rejected. Reference objects do not behave like their primitive values; use get explicitly.

Old references fail with `STALE_REFERENCE` after their content is replaced/deleted or the session is invalidated. Reusing a name does not reuse its identity.

## Events

~~~js
const unsubscribe = ulda.on('status', status => {
  // Keep the handler synchronous, or handle its own asynchronous failures.
});
~~~

Synchronous listener exceptions are isolated from SDK processing. Returned promises from asynchronous listeners are not awaited; handle their rejections yourself.

| Event | Payload |
|---|---|
| `status` | A status string |
| `change` | `{ kind: 'updated', id }` or `{ kind: 'updated' \| 'deleted' \| 'recovered', ids }` |
| `error` | UldaError with a fixed code/message |
| `trace` | Immutable client summary: time, phase='client', event, step, ids, count |
| `reconnect` | Immutable phase plus applicable attempt, delayMs or code |

Reconnect phases: waiting, attempt, restored, stopped, cancelled. Millisecond timestamps and durations are diagnostic metadata, not chain ages or server revisions.

`change` signals that application data may have changed. It contains no plaintext and is not emitted as a substitute for every method's promise. If a deletion closes the SDK, do not read a snapshot from the closed instance.

## Errors

Use `error.code` rather than matching message text. Some validation occurs before a promise is returned.

| Code | Meaning / response |
|---|---|
| `INVALID_INPUT` | Invalid local value, ID, name, path or option |
| `INVALID_PACKET` | Invalid wire shape or binary representation |
| `UNSUPPORTED_PROFILE` | Unsupported or noncanonical ULDA profile |
| `CRYPTO_FAILED` | Authentication, decryption or resource identity failed |
| `CLOSED` | Instance has been closed |
| `OFFLINE` | Transport is unavailable |
| `NOT_OPEN` | No master is open |
| `UNKNOWN_OUTCOME` | A write may have committed; do not replay automatically |
| `CONFLICT` | Witness/state conflict; refresh and reconsider the intention |
| `NOT_FOUND` | Requested resource, content or path does not exist |
| `EXISTS` | Content name is already present |
| `NEEDS_RESYNC` | Integrity/uncertain state blocks normal writes |
| `ROLLBACK` | Older state or different bytes at the same age rejected |
| `LIMIT` | A size, queue, resource or chain-age limit was exceeded |
| `UNSUPPORTED` | Operation is not supported by the current API/profile |
| `SERVER_ERROR` | Server rejection not mapped to a more specific code |
| `STALE_REFERENCE` | Reference no longer addresses the same live context/resource |
| `BUSY` | An operation conflicts with active local work |
| `TIMEOUT` | Connection/read/recovery deadline exceeded |

For writes already sent, loss of an ACK is reported as UNKNOWN_OUTCOME rather than a definite timeout/rollback. Raw server error strings are not propagated.

## SocketIoTransport

An advanced export for configuring the transport and observing safe transport-level diagnostics:

~~~js
import { Ulda, SocketIoTransport } from 'ulda-auth';

const transport = new SocketIoTransport(endpoint, { timeout: 10_000 });
const stopTrace = transport.on('trace', record => {
  // IDs, sizes, fixed event codes and timings; no plaintext.
});
const ulda = new Ulda(endpoint, { transport });
~~~

Options: timeout, allowInsecureLocalhost and diagnostics (false by default). Enabling diagnostics allows optional `ulda:diagnostic` events from a compatible server. It is not an authentication option.

Members:

- `connected`: boolean.
- `start({ signal }?)`: connect, returning Promise<void>.
- `send(packet, { volatile, signal }?)`: internal SDK-created PacketHandle only.
- `disconnect()`: intentional disconnect.
- `close()`: terminal transport cleanup.
- `on(event, listener)`: remove-listener function.

Transport events are changed, disconnect, error and trace. `changed` contains IDs, ciphertext and public witnesses; it is below the SDK's decryption/chain-verification layer. It is not a verified application snapshot.

PacketHandle has no public constructor. A plain object supplied to send is not a supported way to bypass the SDK's encryption path. This boundary prevents accidental misuse; it does not sandbox hostile code in the same process.

## Limits

See the [manifest](../MANIFEST.md) for numeric limits and the [security policy](../SECURITY.md) for trust and memory boundaries. Type declarations describe the API but do not replace runtime validation.

## Capacity and compatibility

See [Limits and capacity planning](LIMITS.md) for SDK bounds, interacting server budgets, eager-loading costs, atomicity, timeouts and upgrades from 1.0.x.
