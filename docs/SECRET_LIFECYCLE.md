# Secret lifecycle

This document describes where SDK values live and when they are released. Private fields and Web Crypto key settings limit accidental API exposure; they do not protect against hostile code controlling the same page or process.

## Values in memory

| Value | Storage and lifetime | Cleanup |
|---|---|---|
| Master password | register/connect argument; connect needs it until the salt is read | Parameter reference is released after KDF starts; internal password bytes are wiped after importKey and on failure |
| PBKDF2/HKDF material | Local non-extractable CryptoKey during derivation | References released after derivation; native copies belong to Web Crypto |
| Master/content AES keys | Private resource context and write lanes | Reused for refresh/reconnect; close releases SDK references; exportKey/wrapKey are disallowed |
| Full origin | Private confirmed state, candidate and write-lane state | Unneeded references released; close wipes known owned root/resource/candidate/pending origins |
| Master catalog | Private IDs, names, content secrets and tokens | Never returned as a public snapshot; references/maps released at close |
| Temporary plaintext bytes | Owned encryption/decryption buffers | Wiped in cleanup paths, including verification failure |
| Write intention and candidate | Bounded per-resource queue and sent-candidate tracking | Completed work released; uncertain candidates may remain until reconciliation or close |
| Application JSON | Verified SDK state and copies returned to the application | SDK releases its own state; it cannot erase copies already handed to the application |
| Event listeners | SDK and transport callback sets | Close detaches SDK transport handlers and clears listeners |
| Recovery plan | Private confirmed source, replacement secrets, reservation and candidates | Retained for explicit continuation; released on success or close |

Content secrets remain in the decrypted private catalog as encoded strings so content keys can be derived. No raw-secret accessor is provided. That does not make these strings inaccessible to a debugger or compromised runtime.

The SDK does not write secrets to localStorage, IndexedDB or files. It does not add the full origin, catalog secrets or plaintext to its diagnostic summaries.

## Close sequence

1. Mark the SDK closed and change the session generation so old references become invalid.
2. Cancel reconnect and SDK network waits.
3. Detach transport callbacks, close queues, wipe known owned origin buffers and release catalog, keys, resources, candidates and recovery state.
4. If connected, attempt a bounded session.close acknowledgement.
5. Close the transport and clear listeners.

Cleanup begins before waiting for the server. Lost or invalid close ACKs cannot restore the context. A previously sent write can still commit; closing is not a server rollback.

Web Crypto does not provide cancellation of already started cryptographic work. Such work can retain local values until it finishes. Guards prevent its late result from publishing or sending a new stage after the session has closed.

## Reference behavior

A content reference captures its resource identity and context generation. After deletion/replacement, adding another content with the same name does not revive it. Previously saved get/update/delete functions still perform the guard checks.

A failed open does not expose a partially initialized context. A later explicit login derives credentials from the newly supplied password. Being offline does not itself erase an already verified snapshot.

## Application responsibilities

The application owns password inputs, any saved credentials/IDs, lock-screen policy, plaintext copies and its logging/telemetry. Call close when the session should end and release application references that are no longer needed.

Non-extractable CryptoKey prevents normal key export. It does not stop hostile same-context code from intercepting input, using available crypto operations or observing plaintext.

JavaScript strings are immutable, garbage collection is nondeterministic, and the core/runtime may allocate intermediate copies outside SDK ownership. Wiping an owned byte buffer does not prove complete erasure of all related data.

See [Security](../SECURITY.md) for the trust model and [Web Crypto security considerations](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#security-considerations) for the API's runtime boundary.
