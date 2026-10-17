# ULDA Auth

A JavaScript SDK for encrypted JSON resources over Socket.IO, built on [ULDA Core](https://github.com/ulda-io/ulda-core).

ULDA Auth encrypts application data on the client, maintains a separate ULDA chain for each resource, and synchronizes changes across connected clients. Applications work with JSON and explicit update methods.

Catalogs have no fixed content-entry count limit. The SDK uses bounded read batches and, with a transfer-capable server, stages large encrypted operations for a single atomic commit. Byte, memory and server admission budgets still apply; see [large catalogs](docs/GUIDE.md#large-catalogs).

## Install

~~~sh
npm install ulda-auth
~~~

Requires Node.js 22 or later, or a browser with ES2022, Web Crypto and WebSocket support. Use an HTTPS endpoint running a compatible [ULDA protocol](docs/PROTOCOL.md) server. A generic Socket.IO server is not sufficient.

The package provides ES modules. JavaScript is the runtime implementation; TypeScript declarations are included for editor assistance and typed applications.

## Quick start

The application supplies the server URL and a password obtained from the user.

~~~js
import { Ulda } from 'ulda-auth';

export async function createNotebook(endpoint, password) {
  const ulda = new Ulda(endpoint);

  try {
    await ulda.ready;
    const masterId = await ulda.register(password);

    await ulda.add('notes', { title: 'First note', done: false });
    await ulda.data.notes.title.update('Updated title');

    const note = ulda.value('notes'); // An independent JSON copy.
    return { masterId, note };
  } finally {
    await ulda.close();
  }
}
~~~

Keep the returned master ID: it identifies the encrypted catalog needed to reopen the data. Store and present it through your application. ULDA Auth does not provide usernames, password reset or an account directory.

To open an existing catalog:

~~~js
import { Ulda } from 'ulda-auth';

export async function openNotebook(endpoint, masterId, password) {
  const ulda = new Ulda(endpoint);
  try {
    await ulda.connect(masterId, password);
    return ulda; // The caller owns this session and must close it when finished.
  } catch (error) {
    await ulda.close();
    throw error;
  }
}
~~~

Resource IDs are decimal **strings**, not JavaScript numbers.

## Working with data

~~~js
const notes = ulda.ref('notes');

const title = notes.title.get();
await notes.title.update('Another title');
await ulda.set('notes', ['done'], true);

// Editing a returned copy does not write to the server.
const copy = ulda.snapshot();

const unsubscribe = ulda.on('change', () => {
  const current = ulda.snapshot();
  // Render or otherwise use the current application data.
});

// Later:
unsubscribe();
await ulda.close();
~~~

References are explicit: use `.get()` to read a value and await `.update()` or `.delete()` to change it. Assigning to a reference does not save data and is rejected.

## Resource model

A **master** is an encrypted catalog of content IDs, names and secrets. A **content** resource holds application JSON. Each has its own encryption material and ULDA chain.

The server stores `id`, public `witness` and encrypted `payload`. Content names, catalog entries, application JSON and the full origin remain inside encrypted containers. IDs, lengths, witness metadata and traffic patterns remain visible.

Successful Create, Read and Update operations subscribe the connection to changes. The initiating connection receives an ACK; other subscribed connections receive updates. Disconnecting clears subscriptions, which are rebuilt by reading after reconnect.

## Concurrency and failures

- Mode **X**, the default, waits for an acknowledgement before sending the next write for that resource. Mode **S** allows a bounded sequence of pending writes.
- Conflicting writers do not merge automatically. Refresh, inspect the current data, and decide whether to apply the intended change again.
- A timeout after sending a write can produce `UNKNOWN_OUTCOME`: the server may have committed it. The SDK never automatically replays writes.
- Creating content uses two server commits: reserve its ID, then atomically update the content and master. An interrupted operation can leave an unreferenced encrypted resource.
- Reconnect retries are bounded. There is no persistent offline write queue.

See the [usage guide](docs/GUIDE.md) for errors, reconnect, deletion and recovery. Read the [security policy](SECURITY.md) before integrating sensitive data.

## Browser entry

With a bundler:

~~~js
import { Ulda } from 'ulda-auth/browser';
~~~

This entry bundles the core and Socket.IO dependencies. Without a bundler, host `dist/ulda-library.js` with the accompanying license notices and import it from your own page using `<script type="module">`. Bare npm package names require a bundler or import map.

## Documentation

- [Usage guide](docs/GUIDE.md) — complete workflows and examples.
- [API reference](docs/API.md) — methods, options, events and errors.
- [Protocol](docs/PROTOCOL.md) — socket events, binary records and server requirements.
- [Method pipelines](docs/PIPELINES.md) — internal steps for each operation.
- [Content recovery](docs/RECOVERY.md) — explicit replacement from a verified local copy.
- [Secret lifecycle](docs/SECRET_LIFECYCLE.md) — storage and cleanup in memory.
- [Manifest](MANIFEST.md) — architecture, supported profile and limits.
- [Security](SECURITY.md) — reporting vulnerabilities and the trust model.

For repository tooling, see [development](https://github.com/ulda-io/ulda-auth/blob/main/docs/DEVELOPMENT.md) and [publishing](https://github.com/ulda-io/ulda-auth/blob/main/docs/PUBLISHING.md).

## License

[ULDA Library Community Source License 1.0](LICENSE.md), a source-available license with revenue and competitive-use conditions. Commercial licensing: [mark@shaposhnik.ch](mailto:mark@shaposhnik.ch).

See the [licensing guide](docs/LICENSING.md) for a summary. Dependencies retain their own licenses.
