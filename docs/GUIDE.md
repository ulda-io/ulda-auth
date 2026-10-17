# Usage guide

## Large catalogs

A master can reference more than 63 contents without changing application calls. Opening or refreshing reads at most 64 content IDs per request, reducing batches if a response is too large. The SDK verifies every required record before publishing the combined local state. Separate batches are not one database snapshot across concurrent writes.

Large catalogs need a server implementing the [transfer extension](PROTOCOL.md#large-operation-transfer). Large encrypted resources travel in 1 MiB fragments; a large `superDelete()` uploads all proofs before one atomic commit. Uploading a partial operation never deletes a partial catalog.

For workloads whose server commit may exceed the default ten-second ACK deadline, configure a measured timeout, for example:

~~~js
const ulda = new Ulda(endpoint, { timeout: 60_000 });
await ulda.connect(masterId, password);
~~~

This timeout is per transport request, not the time budget for loading the entire catalog. Automatic reconnect has its own overall budget. A timeout after Commit can leave an unknown outcome and never authorizes automatic write replay.

There is no numeric catalog-entry quota in the client, but this is not unlimited storage: the encrypted catalog must fit 64 MiB, a logical transfer must fit 128 MiB including item accounting, and the server must have sufficient subscriptions, Router capacity and memory budgets. Application content retains its 1 MiB JSON limit. The client loads/decrypts all listed content eagerly, so opening and refreshing cost time and memory proportional to the data. Nested masters and lazy loading are not implemented.

Upgrade the server and all clients using a shared catalog before exceeding the old limits. Existing containers keep their format; older clients retain their old catalog limits.

## 1. Connect to a compatible server

~~~js
import { Ulda, UldaError } from 'ulda-auth';

const ulda = new Ulda(endpoint, {
  timeout: 10_000,
  reconnect: {
    maxAttempts: 5,
    initialDelay: 500,
    maxDelay: 5_000,
    jitter: 0.2,
    budget: 30_000,
  },
});

await ulda.ready;
~~~

`endpoint` is your HTTPS ULDA server URL. The constructor starts a single Socket.IO WebSocket connection. `ready` waits for the connection and `ulda:hello` acknowledgement; it does not open a master.

For local development only:

~~~js
const ulda = new Ulda('http://127.0.0.1:3000', {
  allowInsecureLocalhost: true,
});
~~~

The endpoint must not contain credentials, a query or a fragment. Pass IDs as decimal strings. Close failed or unused instances with `await ulda.close()`.

## 2. Create or open a master

Create a new encrypted catalog:

~~~js
const masterId = await ulda.register(password);
~~~

The password comes from your application's input flow; do not hardcode a real password. On success, the SDK opens the exact local master it just created and returns its server-assigned ID. There is no extra read or second password derivation.

Present or save `masterId` through the application. The SDK does not maintain an account directory or offer a password-reset service. Closing the SDK clears its working session but does not delete server records.

For an existing master, use a fresh instance and call:

~~~js
await ulda.connect(masterId, password);
~~~

The SDK reads and decrypts the master, obtains content IDs and secrets from its private catalog, and reads and verifies those contents. No partial catalog becomes the active session if one required resource fails verification.

Use `register` or `connect` to establish a session, not to switch between masters in an already open instance. Close that instance and create another one when switching accounts.

## 3. Create content

~~~js
await ulda.add('profile', {
  displayName: 'Ada',
  preferences: { theme: 'light' },
  tags: ['personal', 'work'],
});
~~~

Names are local catalog keys, not server-visible labels. They must be unique in the master, nonempty strings of at most 256 UTF-16 code units.

`add` generates independent content secrets, reserves an encrypted empty content resource, receives its ID, then atomically writes the actual content and the updated encrypted master. The return value is `{ ok: true, name, subscriptionReady }`.

`subscriptionReady` reports whether the transport is still connected at completion. A disconnect after commit does not undo the operation.

The reservation and final update are two separate commits. Do not automatically repeat `add` after `UNKNOWN_OUTCOME`. A failure can leave a reserved resource. On the same instance, a known reservation can be retained for an explicit continuation with the same name, mode and data after the applicable checks; it is not a durable recovery mechanism.

## 4. Read local data

~~~js
const profile = ulda.value('profile');
const theme = ulda.value('profile', ['preferences', 'theme']);
const allContent = ulda.snapshot();
~~~

These methods read the last verified **local** state and do not send a Read request. They return independent JSON copies. Modifying a copy does not update the SDK or server.

Use `await ulda.refresh()` when you need to read and verify the server's current snapshot. Local reads remain available while an open session is disconnected or needs resynchronization, but their data may be stale.

## 5. Update a resource or a field

Replace the entire content value:

~~~js
await ulda.update('profile', {
  displayName: 'Ada',
  preferences: { theme: 'dark' },
  tags: ['personal'],
});
~~~

Update a nested value:

~~~js
await ulda.set('profile', ['preferences', 'theme'], 'light');
await ulda.set('profile', ['tags', 0], 'private');
~~~

Intermediate path components must already exist. An object field may be added at the final path component. An array index must already exist; replacing an array is the way to append elements.

Remove a field or array element:

~~~js
await ulda.remove('profile', ['preferences', 'theme']);
await ulda.remove('profile', ['tags', 0]);
~~~

Array removal uses splice semantics: later elements shift left. `remove(name, [])` is not supported; use `delete(name)` to delete the content resource.

Each update prepares and encrypts the next resource state. It becomes confirmed local state after its valid ACK, without echoing the same update back from the server.

## 6. Use explicit references

~~~js
const profile = ulda.ref('profile');
// Equivalent: const profile = ulda.data.profile;

const displayName = profile.displayName.get();
await profile.displayName.update('Grace');
await profile.preferences.field('theme').update('dark');
await profile.preferences.theme.delete();
~~~

References also work for primitives and arrays. A reference to `false` is still an object, so read `.get()` before using it in a boolean condition.

Use `field` when a property name conflicts with a reference method:

~~~js
await ulda.add('settings', { update: 'manual' });
const value = ulda.data.settings.field('update').get();
~~~

Use `ulda.data.field(name)` or `ulda.ref(name)` for dynamic content names. Do not assign properties, use the JavaScript `delete` operator or call `Object.defineProperty` on references.

References are bound to the original content ID and session. Deleting and recreating content with the same name does not revive an old reference. Get a new reference after recovery or reopening.

## 7. Receive updates

~~~js
const stopChanges = ulda.on('change', (event) => {
  // event carries resource IDs and a kind, not decrypted content.
  const current = ulda.snapshot();
  // Update your application's view.
});

const stopStatus = ulda.on('status', (status) => {
  // Reflect open, disconnected, reconnecting or needsResync in the UI.
});

const stopErrors = ulda.on('error', (error) => {
  // Handle error.code; avoid logging application secrets.
});
~~~

Incoming changes are verified before being published to the working state. A master update can introduce content IDs that the SDK then reads using the secrets in the decrypted catalog.

Read, Create and Update subscribe the connection automatically. There is no public `watch` flag or per-resource unsubscribe method. Subscriptions end with the connection. Calling the returned listener functions removes **local callbacks**, not server subscriptions.

Use operation promises to determine whether your own writes succeeded. `change` is an invalidation signal, not a receipt for every local method or a complete transaction log.

## 8. Handle conflicts and uncertain outcomes

Wrap the method call itself and its await in try/catch: some invalid input is rejected synchronously.

~~~js
try {
  await ulda.set('profile', ['displayName'], proposedName);
} catch (error) {
  if (!(error instanceof UldaError)) throw error;

  if (error.code === 'CONFLICT' || error.code === 'NEEDS_RESYNC') {
    await ulda.refresh();
    // Inspect ulda.status and ulda.value('profile').
    // Ask the application/user to resolve the intended change.
  } else if (error.code === 'UNKNOWN_OUTCOME') {
    // The write may have committed. Do not automatically send it again.
    // Inspect a verified snapshot when possible; keep the original outcome uncertain.
  } else {
    throw error;
  }
}
~~~

Do not assume that a successful `refresh()` always makes writing safe: `status` can remain `needsResync` when an unresolved operation or recovery plan exists. Wait for active write promises to settle before refreshing; otherwise `BUSY` can be returned.

A newer server snapshot may be accepted without all intermediate chain steps. This is the documented [trust model](../SECURITY.md), not a proof that no newer version was withheld.

## 9. Reconnect

After an unintentional disconnect from a previously established connection, the SDK makes bounded reconnect attempts and verified reads. It does not replay Create, Update or Delete.

~~~js
const stopReconnect = ulda.on('reconnect', (event) => {
  // phase: waiting, attempt, restored, stopped or cancelled
});

await ulda.reconnect(); // Explicit recovery; joins a running cycle.
~~~

Set `reconnect: false` to disable automatic attempts while retaining manual reconnect. A failed initial connection is not automatically retried. The retry budget, attempt limits and events are described in the [API](API.md).

Reconnect restores subscriptions by reading again; it does not restore a server-side event log or offline queue.

## 10. Choose X or S

~~~js
await ulda.add('settings', { theme: 'light' }, 'X');
await ulda.add('progress', { count: 0 }, 'S');

await Promise.all([
  ulda.update('progress', { count: 1 }),
  ulda.update('progress', { count: 2 }),
  ulda.update('progress', { count: 3 }),
]);
~~~

X serializes writes through their ACKs. S prepares consecutive states in a bounded window while earlier ACKs are pending. Every returned promise still corresponds to its own operation.

S is not a CRDT, cross-client merge strategy or unlimited stream. Foreign changes and failures can stop the queue. Mode is selected when content is created; there is no public method to change it. The master always uses X.

## 11. Delete data

~~~js
await ulda.delete('profile');
~~~

The SDK refreshes first, then atomically deletes the content and updates the master's catalog. If another master references that content ID, it is affected too: the server cannot inspect encrypted catalogs to discover shared references.

To delete the complete catalog and all content it currently lists:

~~~js
await ulda.superDelete();
~~~

`superDelete` refreshes and validates the set, sends one atomic deletion batch, and closes the SDK on success. A missing or invalid required content can stop it before deletion. This is not a blind cleanup operation for damaged catalogs.

## 12. Recover damaged content explicitly

~~~js
const recovery = await ulda.recoverContent('notes');
const newReference = ulda.ref('notes');
~~~

This replaces one catalog link with a newly created resource built from the SDK's last confirmed local copy. The old resource is preserved, not added as a second link. Recovery can lose newer changes absent from that copy. It is not password recovery and does not recreate masters.

Read [Content recovery](RECOVERY.md) before implementing this action.

## 13. Close and release the session

~~~js
stopChanges();
stopStatus();
stopErrors();
await ulda.close();
~~~

Close cancels SDK waits, invalidates references, wipes known owned origin buffers and releases keys and catalog references. It makes a best-effort session-close request and disconnects. It does not delete data or undo an already sent write.

The application must clear its password input and its own plaintext copies. See [Secret lifecycle](SECRET_LIFECYCLE.md).

## Optional TypeScript use

~~~ts
import { Ulda } from 'ulda-auth';

type Workspace = {
  notes: { title: string; done: boolean };
};

const ulda = new Ulda<Workspace>(endpoint);
await ulda.connect(masterId, password);
await ulda.data.notes.done.update(true);
~~~

The implementation remains JavaScript. Declarations describe the application's expected shape; they do not add server-side schema validation or validate arbitrary input against your TypeScript type.

## Capacity and compatibility

See [Limits and capacity planning](LIMITS.md) for SDK bounds, interacting server budgets, eager-loading costs, atomicity, timeouts and upgrades from 1.0.x.
