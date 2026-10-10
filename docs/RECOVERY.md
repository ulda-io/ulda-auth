# Explicit content recovery

`recoverContent(name)` creates a replacement content resource from the SDK's last confirmed local copy and replaces one entry in the master. The old server resource is preserved. It is not connection recovery, password recovery or automatic repair.

## When to use it

Use this action when a content resource cannot be obtained in a valid form but the open SDK still holds a confirmed copy. A bad response alone does not prove that the stored resource is permanently damaged; an explicit refresh may be sufficient.

Recovery may discard newer changes missing from the local source. Let the application or user make that decision. No merge is performed.

~~~js
const result = await sdk.recoverContent('notes');
const current = sdk.ref('notes');
~~~

Result:

~~~js
{
  ok: true,
  previousId: '102',
  id: '205',
  sourceAge: 3,
  reconciled: false
}
~~~

`sourceAge` is the age of the original confirmed chain, not a timestamp or the replacement's age. `reconciled: true` means this call confirmed a prior uncertain recovery update through verified reads. The earlier rejected promise remains rejected.

On completion, the change notification has kind recovered and includes both IDs.

## Preconditions

- A verified master and confirmed local copy of the selected content must exist.
- The transport must be connected, without an active reconnect cycle or competing local operation.
- A session in needsResync after corrupt input may recover, but unresolved normal writes cannot be used as a recovery source.
- An unacknowledged candidate or arbitrary JSON supplied by the application is not accepted as the source.
- There is only one retained recovery plan per SDK. Normal writes are blocked while it remains unresolved.

If there is no local source, recovery returns NOT_FOUND before sending writes. Opening a damaged resource on a new device does not create such a source. A trusted deletion notification clears the working copy; no hidden recovery backup is kept.

## Operation

1. Capture the confirmed JSON, mode, source age and original catalog identity.
2. Read and verify the master. Its entry must still refer to the same ID, key and token.
3. Read and verify other required content. The damaged target is not used as a source.
4. Generate a new content key material, token and chain. Encrypt an empty reservation.
5. Create the reservation and retain its returned ID.
6. Prepare the replacement with the captured JSON and an encrypted master with exactly one replaced entry.
7. Commit both through one atomic Update.
8. Publish the verified set and release the plan on success.

The master keeps its ID and key. The replacement has new secrets, ID and chain. The master does not keep two links for the same name. Other masters referencing the old ID are not modified.

Create and Update are separate commits. An unreferenced reservation may remain if the second stage fails.

## Repeating the explicit action

Repeat the same method with the same name on the **same SDK instance** to continue a retained plan. The source does not silently switch to another copy.

| Situation | Continuation |
|---|---|
| Master/other content validation failed before Create | Verify again; retain the original source |
| Create returned a valid definite rejection | A later explicit call may attempt Create after checking again |
| Create ACK was lost/invalid or returned an unusable conflicting ID | UNKNOWN_OUTCOME; do not create again or guess an ID |
| Reservation ID is known; Update returned a definite rejection | Verify the master and exact reserved record; reuse that reservation |
| Reserved record was removed or changed | NOT_FOUND/CONFLICT; do not silently create a different replacement |
| Update ACK was lost/invalid | Read only; report reconciled=true if the intended new link and full snapshot verify |
| Read still shows the old/different link after an uncertain Update | Keep UNKNOWN_OUTCOME; that read does not prove the write will never commit |
| Another client replaced the original catalog entry | CONFLICT; do not overwrite its replacement |
| SDK was closed | CLOSED; late replies cannot restore the session |

An operation can continue on the server after a client timeout. A single read showing the old state is not evidence that the uncertain Update can safely be resent.

`refresh()` may update the verified snapshot while the plan remains, but it does not by itself release the plan or enable normal writes. Reconnect never submits recovery writes. Continue explicitly with recoverContent or close the instance.

Closing discards the plan. A new SDK session does not resume it, recover an unknown ID or remove a leftover reservation.

## References, sharing and privacy

Old references address the old content identity and must be replaced with a new `ref`. Other clients observe the changed master, decrypt its entry and read the replacement.

The old resource remains because other encrypted catalogs may still reference it. The server cannot enumerate those relationships. Recovery does not revoke keys or plaintext already obtained by other parties.

The plan stays in private memory, not localStorage or diagnostics. Close releases it and wipes known owned origins. JavaScript memory limits described in [Secret lifecycle](SECRET_LIFECYCLE.md) still apply.

There is no master-recreation method. Preserving or changing a master login ID requires a separate application/protocol design.
