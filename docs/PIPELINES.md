# Method pipelines

These steps describe the implemented client behavior and the required compatible-server actions. See [API](API.md) for signatures and [Protocol](PROTOCOL.md) for exact packets.

## Shared rules

~~~text
confirmed state = verified data + origin + token + witness + encrypted record + age
candidate = a prepared next state that has not necessarily received an ACK
seal(state) = authenticate/encrypt token, full origin and JSON; bind the witness
wire = IDs, public witnesses and encrypted payloads only
ACK = the response to one request
Changed = an independent subscription notification
~~~

Names and secrets are resolved locally. Before each not-yet-sent mutation stage, check session generation, connection and integrity-fault state. Already sent writes retain their ACK or UNKNOWN_OUTCOME; a local fault cannot roll them back.

## Constructor, ready and Hello

~~~text
validate endpoint/options
create or use one transport; create private state and bounded queues
attach Changed/disconnect/error handlers
connect Socket.IO -> emit hello({}) -> validate ACK
if no newer fault occurred: resolve ready, status = ready
on failure: reject with a fixed local error
~~~

No password or master is involved in Hello.

## register(password)

~~~text
await ready; require no open/opening master
serialize local activation against incoming changes
derive a non-extractable master key from password + random salt
create X origin, identity token and empty catalog
seal the master -> prepare opaque Create handle
send volatile Create -> server commits, assigns ID and subscribes before ACK
validate the single returned ID
if session remains valid: associate that ID with the prepared local state
publish catalog/key/state; expose the reference tree; return ID
process queued incoming changes after activation
~~~

No reread or second KDF is needed. If Create's result is uncertain, do not open a successful context, guess its ID or automatically retry.

## connect(id, password)

~~~text
await readiness; require no existing/opening context
Read [master ID]
validate record -> derive key from password and its salt -> authenticate/decrypt
check origin/witness, X mode and catalog structure
extract content IDs, names, secrets and tokens privately
Read content ID array(s)
derive keys and verify every required content
check session/connection/fault guards
publish master and resources together; build write lanes; return reference tree
~~~

Read subscribes to each requested ID. A failure does not expose a partially opened catalog.

## add(name, data, mode)

~~~text
validate name/mode/JSON; serialize catalog work; require unused name and capacity
generate independent content secret, token, salt and origin
seal null data -> Create encrypted reservation -> remember ACK ID
prepare next content state with application JSON
copy master catalog; add the private ID/name/key/token entry
advance master chain and encrypt the new catalog
check guards -> one Update [content, master]
server validates both and commits both or neither; ensures subscriptions; ACKs
after ACK, publish prepared states without replacing a newer verified state
discard completed reservation state; return name and current subscriptionReady
~~~

The reservation and Update are separate commits. A failed operation can leave a resource. A known reservation can be retained for a matching explicit continuation; an unknown Create ID is not recovered automatically.

## update, set and remove

~~~text
resolve content name to ID; require a writable context
copy input and path; enqueue an intention in that resource's write lane
apply intention to a copy of the lane's current data
advance origin -> produce next witness -> encrypt complete resource
check guards -> send Update [candidate]
server atomically validates/replaces witness + payload and ACKs
on ACK: verify/apply the candidate unless a newer valid state is already present
resolve this operation's promise
on uncertain result: retain required candidate information and block unsafe writes
~~~

`update` replaces the root. `set` replaces a node. `remove` deletes an object field or splices an array element. None sends a plaintext patch: the changed resource is re-encrypted in full.

### X and S lanes

~~~text
X: wait for the pending ACK before preparing/sending the next write
S: prepare consecutive states within the N=5 unconfirmed window
every write has its own ACK/promise
a foreign branch or failure can stop the lane and reject queued intentions
refresh can reopen the lane only when its uncertain-state checks permit it
~~~

S does not merge concurrent writers or turn several updates into one transaction.

## snapshot, value and references

~~~text
require an available open-catalog context
snapshot: copy each currently available content JSON under its local name
value: locate content and requested path; return an independent JSON copy
ref/data: capture content identity and session generation, not catalog secrets
reference.get/toJSON -> local value read
reference.update -> set
reference.delete -> remove, or delete at content root
reference.field -> create another reference for a child path
~~~

There is no socket request. Direct Proxy assignment/deletion is rejected. Identity/generation guards invalidate references after replacement or close.

## delete(name)

~~~text
require no conflicting local work; acquire exclusive operation guard
refresh and verify master/content
resolve target from refreshed catalog
prepare next-witness deletion proof for content
remove its catalog entry; advance/encrypt master
check guards -> one Delete [content proof, encrypted master replacement]
server verifies every entry and commits all or none
on ACK: remove local resource/lane and accept catalog without rolling back newer state
on uncertain outcome: preserve uncertainty and block unsafe writes
~~~

Refresh does not lock the server. A concurrent writer can still cause conflict at commit.

## superDelete()

~~~text
acquire exclusive guard -> refresh all listed resources
prepare a next-witness deletion proof for each content and the master
check guards -> one Delete batch
server validates and deletes all or none
on valid ACK: close SDK and release the context
~~~

A missing or invalid required resource stops preflight. The method cannot discover records absent from the encrypted catalog.

## Incoming Changed

~~~text
validate event shape and limits -> enqueue in the bounded incoming sequence
stage known resource updates; authenticate/decrypt and verify lineage
if master changed: validate its catalog and resolve newly referenced content by Read
keep a pending Add's verified new-content state private until local activation
check the complete required staged set before publication
then apply trusted deletions and accepted updates
close the context if the master was deleted
update lanes/references; emit safe change metadata
~~~

Invalid known updates reject a mixed event before its deletions are applied. Unknown resources are not published without credentials.

When a foreign update precedes an ACK, bridge only through exact candidates the SDK actually sent, checking each permitted transition. Receiving Changed never substitutes for a missing ACK.

## refresh()

~~~text
require an open catalog and no conflicting active local writes
record session/connection/fault generation
Read master -> authenticate and check identity/mode/age
Read every referenced content -> authenticate and check against known anchors
accept a newer authenticated snapshot without requiring missed intermediate steps
if any required record or guard fails: retain previous verified snapshot
otherwise replace the staged set, synchronize lanes and rebuild Read subscriptions
resolve uncertainty only where the observed state permits it
status = open, or needsResync when an unresolved operation remains
return reference tree
~~~

Refresh sends no mutation and does not advance any chain. Its success does not turn a previously rejected write promise into success.

## Disconnect and reconnect

~~~text
disconnect:
    advance connection generation; stop new writes and reject queued intentions
    sent writes without a definite ACK become uncertain
    retain verified application state for local reads
    ignore queued events from the previous connection
    if unintentional and a connection was previously established: start bounded recovery

recovery cycle:
    one shared cycle for concurrent callers
    bounded attempts, exponential delay/jitter and a total deadline
    wait for old local operations to settle
    connect -> Hello -> verified refresh if a master exists
    recheck cancellation/session/connection guards before publication
    success: open, or ready if no catalog
    retry transport/time/BUSY errors within budget
    stop on invalid data, missing required state or unresolved uncertainty
~~~

Manual reconnect joins this mechanism. There is no persistent offline queue or mutation replay. Close cancels the cycle. Native Web Crypto work may complete later, but guarded results cannot reopen a closed session.

## recoverContent(name)

~~~text
require confirmed local source and no conflicting work
retain one private plan: source data/mode/age, old identity, new credentials
Read and verify master plus other required contents
ensure the master still points to the original resource
create encrypted empty replacement -> remember its assigned ID
prepare replacement data and master with one substituted catalog entry
one atomic Update [replacement, master] -> validate ACK -> publish the full set
preserve old server record; invalidate its local reference; return recovery metadata
~~~

A repeated explicit call uses the same plan and known reservation. An uncertain Update is resolved by reads only; an unknown Create ID blocks continuation. The detailed cases are in [Recovery](RECOVERY.md).

## close()

~~~text
mark closed and advance session generation
cancel reconnect and SDK transport waits
detach transport handlers; close lanes and invalidate references
wipe known owned origin buffers; release catalog/keys/resources/candidates/plans
if connected: attempt bounded session.close ACK
close transport and clear listeners
~~~

Cleanup does not wait for the server to cooperate. It does not erase application-owned copies, reverse commits or guarantee erasure of every JavaScript/runtime allocation.
