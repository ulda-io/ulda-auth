import { check, UldaError, safeError } from "./errors.js";
import {
  id,
  name,
  json,
  unb64,
  equal,
  pathValue,
  edit,
  exact,
  LIMITS,
} from "./values.js";
import { newOrigin, advance, inspect, verify } from "./core.js";
import {
  masterCredentials,
  contentCredentials,
  newContentSecret,
  newToken,
  seal,
  open,
  envelope,
  sealedWire,
} from "./crypto.js";
import {
  readPacket,
  writePacket,
  deletePacket,
  deletionProof,
  emptyPacket,
} from "./protocol.js";
import { SocketIoTransport } from "./transport.js";
import { WriteLane } from "./queue.js";
import { reference, dataTree } from "./proxy.js";
import { CLIENT_STEPS, stepRecord } from "./diagnostics.js";
import { Reconnector, reconnectOptions, checkSignal, abortable } from "./reconnect.js";

export class Ulda {
  #transport;
  #status = "connecting";
  #ready;
  #root;
  #masterCredentials;
  #resources = new Map();
  #lanes = new Map();
  #sentCandidates = new Map();
  #inbound = Promise.resolve();
  #inboundCount = 0;
  #inboundBytes = 0;
  #masterTail = Promise.resolve();
  #masterTasks = 0;
  #generation = 0;
  #listeners = new Map();
  #adds = new Map();
  #catalogUnknown = -1;
  #closed = false;
  #closing;
  #opening = false;
  #exclusive = false;
  #tree;
  #recovery;
  #initialStart;
  #established = false;
  #connectionEpoch = 0;
  #exclusiveDone = Promise.resolve();
  #lifetime = new AbortController();
  #transportOff = [];
  #repair;
  #faultEpoch = 0;
  constructor(endpoint, options = {}) {
    check(
      options &&
        typeof options === "object" &&
        !Array.isArray(options) &&
        Object.keys(options).every((key) =>
          ["transport", "timeout", "allowInsecureLocalhost", "reconnect"].includes(key),
        ),
    );
    const recoveryOptions = reconnectOptions(options.reconnect);
    this.#transport =
      options.transport ?? new SocketIoTransport(endpoint, options);
    this.#recovery = new Reconnector(recoveryOptions, signal => this.#recover(signal), event => {
      if (event.phase === "stopped" && !this.#closed) {
        this.#status = this.#transport.connected ? "needsResync" : "disconnected";
        this.#emit("status", this.#status);
      }
      this.#trace(`reconnect.${event.phase}`, [], event.attempt ?? 0);
      this.#emit("reconnect", Object.freeze(event));
      if (event.phase === "stopped" && !this.#closed) this.#emit("error", new UldaError(event.code));
    });
    this.#transportOff.push(this.#transport.on("changed", (event) => {
      const epoch = this.#connectionEpoch;
      const bytes = event.updated.reduce((n, x) => n + x.witness.length + x.payload.length + 256, event.deleted.length * 256);
      if (this.#inboundCount >= LIMITS.incoming || this.#inboundBytes + bytes > LIMITS.transferBytes)
        return this.#fault(new UldaError("LIMIT"));
      this.#inboundBytes += bytes;
      this.#serial(() => epoch === this.#connectionEpoch ? this.#changed(event) : undefined)
        .catch((e) => { if (epoch === this.#connectionEpoch) this.#fault(e); })
        .finally(() => { this.#inboundBytes -= bytes; });
    }));
    this.#transportOff.push(this.#transport.on("disconnect", (event) => {
      this.#connectionEpoch++;
      if (!this.#closed) {
        this.#status = "disconnected";
        for (const l of this.#lanes.values()) l.stop();
        this.#emit("status", this.#status);
        if (this.#closed) return;
        if (event?.intentional) this.#recovery.cancel();
        else if (this.#established) this.#recovery.run({ automatic: true }).then(() => {}, () => {});
      }
    }));
    this.#transportOff.push(this.#transport.on("error", (e) => this.#fault(e)));
    this.#initialStart = this.#ready = this.#start(this.#lifetime.signal);
    this.#ready.catch(() => {});
  }
  get ready() {
    return this.#ready;
  }
  get status() {
    return this.#status;
  }
  get contextGeneration() {
    return this.#generation;
  }
  get data() {
    this.#requireOpen();
    return this.#tree;
  }
  on(event, listener) {
    check(!this.#closed, "CLOSED");
    check(
      ["change", "status", "error", "trace", "reconnect"].includes(event) &&
        typeof listener === "function",
    );
    const s = this.#listeners.get(event) ?? new Set();
    s.add(listener);
    this.#listeners.set(event, s);
    return () => s.delete(listener);
  }
  #emit(event, value) {
    for (const fn of this.#listeners.get(event) ?? []) {
      try {
        fn(value);
      } catch {
        /* Callback isolation. */
      }
    }
  }
  #fault(error) {
    if (this.#closed) return;
    this.#faultEpoch++;
    this.#status = "needsResync";
    this.#trace("resync.required");
    for (const l of this.#lanes.values()) l.stop();
    this.#emit("status", this.#status);
    this.#emit("error", safeError(error));
  }
  #trace(step, ids = [], count = 0) {
    if (!this.#listeners.get("trace")?.size) return;
    try {
      this.#emit("trace", Object.freeze({ time: Date.now(), phase: "client", event: step,
        ...stepRecord(CLIENT_STEPS, step, ids.slice(0, LIMITS.batch), count) }));
    } catch { /* Diagnostic callbacks never change operation results. */ }
  }
  async #openRecord(credentials, record, token, kind = "content") {
    const generation = this.#generation;
    this.#guard(generation);
    // The role comes only from the client's decrypted catalog / chosen login ID.
    this.#trace(`${kind}.decrypt`, [record.id]);
    this.#guard(generation);
    const result = await open(credentials, record, token, kind === "master");
    try { this.#guard(generation); }
    catch (error) { result.origin.fill(0); throw error; }
    this.#trace(`${kind}.opened`, [record.id]);
    return result;
  }
  #serial(fn) {
    this.#inboundCount++;
    const next = this.#inbound.then(fn);
    // The queue retains completion only, never a Proxy result that close can invalidate
    // while Promise.finally is still assimilating its value.
    this.#inbound = next.then(() => {}, () => {}).finally(() => this.#inboundCount--);
    return next;
  }
  async #start(signal) {
    const faultEpoch = this.#faultEpoch;
    try {
      checkSignal(signal);
      await this.#transport.start({ signal });
      check(!this.#closed, "CLOSED");
      checkSignal(signal);
      const epoch = this.#connectionEpoch;
      await this.#transport.send(emptyPacket("hello"), { signal });
      check(!this.#closed, "CLOSED");
      checkSignal(signal);
      check(epoch === this.#connectionEpoch && this.#transport.connected, "OFFLINE");
      this.#faultGuard(faultEpoch);
      this.#established = true;
      this.#status = this.#root ? "needsResync" : "ready";
    } catch (e) {
      if (!this.#closed) this.#status = e?.code === "NEEDS_RESYNC" && this.#transport.connected ? "needsResync" : "disconnected";
      throw safeError(e);
    }
  }
  #requireOpen(write = false) {
    check(!this.#closed, "CLOSED");
    check(this.#root, "NOT_OPEN");
    if (write) {
      check(!this.#repair, "NEEDS_RESYNC");
      check(
        this.#status === "open" && this.#transport.connected,
        "NEEDS_RESYNC",
      );
      check(!this.#exclusive, "BUSY");
    }
  }
  #guard(generation) {
    check(!this.#closed, "CLOSED");
    check(generation === this.#generation, "STALE_REFERENCE");
  }
  #connectionGuard(generation, epoch, signal) {
    this.#guard(generation);
    checkSignal(signal);
    check(epoch === this.#connectionEpoch && this.#transport.connected, "OFFLINE");
  }
  #faultGuard(epoch) {
    check(epoch === this.#faultEpoch, "NEEDS_RESYNC");
  }
  #writeGuard(generation, faultEpoch) {
    this.#guard(generation);
    this.#faultGuard(faultEpoch);
    check(this.#transport.connected, "OFFLINE");
  }
  async #recover(signal) {
    // Drain old writes before opening another connection. A prepared operation
    // from the disconnected socket must never be sent on its replacement.
    await abortable(Promise.all([
      this.#initialStart.catch(() => {}), this.#inbound, this.#masterTail,
      this.#exclusiveDone, ...[...this.#lanes.values()].map(lane => lane.idle()),
    ]), signal);
    checkSignal(signal);
    check(!this.#closed, "CLOSED");
    this.#status = "reconnecting";
    this.#emit("status", this.#status);
    checkSignal(signal);
    await this.#start(signal);
    if (this.#root) await this.#refresh(signal);
    else this.#emit("status", this.#status);
    checkSignal(signal);
    check(!this.#closed, "CLOSED");
    check(this.#transport.connected, "OFFLINE");
    check(this.#status === "open" || this.#status === "ready", "NEEDS_RESYNC");
    return this.#tree;
  }
  #catalog(data) {
    exact(data, ["contents"]);
    check(
      Array.isArray(data.contents),
      "LIMIT",
    );
    const names = new Set(),
      ids = new Set();
    for (const e of data.contents) {
      exact(e, ["id", "name", "key", "token"]);
      id(e.id);
      name(e.name);
      check(unb64(e.key, 32).length === 32 && unb64(e.token, 32).length === 32);
      check(!names.has(e.name) && !ids.has(e.id));
      names.add(e.name);
      ids.add(e.id);
    }
    return data.contents;
  }
  #entry(content) {
    this.#requireOpen();
    name(content);
    const entry = this.#root.data.contents.find((x) => x.name === content);
    check(entry, "NOT_FOUND");
    return entry;
  }
  async #prepare(base, credentials, change) {
    const generation = this.#generation;
    this.#guard(generation);
    this.#trace("write.prepare", [base.id]);
    const catalog = base.id === this.#root?.id;
    const data = json(change(json(base.data, catalog)), catalog);
    const origin = advance(base.origin);
    try {
      this.#trace("chain.advance", [base.id]);
      const sealed = await seal(credentials, base.token, origin, data, catalog);
      this.#guard(generation);
      this.#trace("write.sealed", [base.id]);
      const wire = sealedWire(sealed);
      return {
        id: base.id,
        origin,
        token: base.token,
        data,
        witness: wire.witness,
        record: { id: base.id, ...wire },
        sealed,
        ...inspect(origin),
      };
    } catch (error) { origin.fill(0); throw error; }
  }
  async #checkProgress(previous, next, fresh = false) {
    if (!previous) return;
    check(
      next.mode === previous.mode && next.token === previous.token,
      "CRYPTO_FAILED",
    );
    check(next.age >= previous.age, "ROLLBACK");
    if (next.age === previous.age) {
      check(
        equal(next.record.witness, previous.record.witness) &&
          equal(next.record.payload, previous.record.payload),
        "ROLLBACK",
      );
      return;
    }
    // A complete refresh accepts an authenticated server-selected snapshot.
    // Normal updates still require lineage; neither path may change identity
    // or roll back a previously accepted state (checked above).
    if (!fresh) {
      let linked = await verify(previous.witness, next.witness);
      if (!linked) {
        // With no echo, a foreign successor can precede our delayed/lost ACK.
        // Bridge only through exact local candidates that were actually sent;
        // this validates chain progress, it never resolves their write Promises.
        const candidates = [...(this.#sentCandidates.get(next.id) ?? [])]
          .filter(s => s.age > previous.age && s.age < next.age)
          .sort((a, b) => a.age - b.age);
        const reachable = [previous];
        for (const candidate of candidates) {
          for (const base of reachable) {
            if (await verify(base.witness, candidate.witness)) {
              reachable.push(candidate);
              break;
            }
          }
        }
        for (const base of reachable.slice(1)) {
          if (await verify(base.witness, next.witness)) { linked = true; break; }
        }
      }
      check(linked, "NEEDS_RESYNC");
    }
    this.#trace(fresh ? "snapshot.checked" : "chain.checked", [next.id ?? next.record.id]);
  }
  #forgetCandidates(resourceId, throughAge = Infinity) {
    const states = this.#sentCandidates.get(resourceId);
    if (!states) return;
    for (const state of states) if (state.age <= throughAge) states.delete(state);
    if (!states.size) this.#sentCandidates.delete(resourceId);
  }
  async #sendWrite(packet, states) {
    check(!this.#closed, "CLOSED");
    for (const state of states) {
      const set = this.#sentCandidates.get(state.id) ?? new Set();
      set.add(state);
      this.#sentCandidates.set(state.id, set);
    }
    try {
      await this.#transport.send(packet, { volatile: true, signal: this.#lifetime.signal });
    } catch (error) {
      // Unknown candidates may have committed. Keep the bounded proof path until
      // a confirmed state supersedes it, refresh resolves it, or the SDK closes.
      if (error.code !== "UNKNOWN_OUTCOME") for (const state of states) {
        const set = this.#sentCandidates.get(state.id);
        set?.delete(state);
        if (!set?.size) this.#sentCandidates.delete(state.id);
      }
      throw error;
    }
  }
  #makeLane(state, credentials) {
    const generation = this.#generation;
    return new WriteLane(
      state,
      async (base, change) => {
        this.#guard(generation);
        const next = await this.#prepare(base, credentials, change);
        this.#guard(generation);
        return next;
      },
      (next) => {
        this.#guard(generation);
        return this.#sendWrite(
          writePacket("update", [{ id: next.id, sealed: next.sealed }]),
          [next],
        );
      },
      (next) =>
        this.#serial(async () => {
          this.#guard(generation);
          await this.#acceptContent(next);
        }),
    );
  }
  async #acceptContent(next, fresh = false) {
    const old = this.#resources.get(next.id);
    if (old && next.age < old.state.age) return;
    await this.#checkProgress(old?.state, next, fresh);
    if (!old) return;
    old.state = next;
    this.#forgetCandidates(next.id, next.age);
    this.#lanes.get(next.id)?.observe(next, { refresh: fresh });
    this.#trace("content.memory", [next.id]);
    this.#emit("change", { id: next.id, kind: "updated" });
  }
  async register(password) {
    await this.#ready;
    check(!this.#closed, "CLOSED");
    check(!this.#root && !this.#opening, "BUSY");
    check(this.#status === "ready", "NEEDS_RESYNC");
    this.#opening = true;
    try {
      // Queue Changed behind activation: a foreign update may precede a delayed
      // Create ACK. It must not be discarded merely because root is not set yet.
      return await this.#serial(async () => {
        const generation = this.#generation;
        this.#guard(generation);
        const faultEpoch = this.#faultEpoch;
        this.#trace("master.key.derive");
        const deriving = masterCredentials(password);
        password = undefined;
        const credentials = await deriving;
        this.#guard(generation);
        this.#trace("master.key.ready");
        const origin = newOrigin("X"), token = newToken(), data = json({ contents: [] });
        try {
          this.#trace("master.origin.new");
          const encrypted = await seal(credentials, token, origin, data);
          this.#trace("master.sealed");
          this.#writeGuard(generation, faultEpoch);
          const [resourceId] = await this.#transport.send(
            writePacket("create", [{ sealed: encrypted }]),
            { volatile: true, signal: this.#lifetime.signal },
          );
          this.#guard(generation);
          const wire = sealedWire(encrypted);
          this.#generation++;
          this.#root = { id: resourceId, origin, token, data, witness: wire.witness,
            record: { id: resourceId, ...wire }, ...inspect(origin) };
          this.#masterCredentials = credentials;
          this.#tree = dataTree(this, this.#generation);
          // Do not overwrite a concurrent disconnect or incoming-queue fault.
          if (!this.#transport.connected) this.#status = "disconnected";
          else if (this.#status !== "needsResync") this.#status = "open";
          this.#trace("master.local.accepted", [resourceId]);
          this.#trace("session.memory", [resourceId], 0);
          return resourceId;
        } finally { if (this.#root?.origin !== origin) origin.fill(0); }
      });
    } finally {
      password = undefined;
      this.#opening = false;
    }
  }
  async connect(masterId, password) {
    id(masterId);
    await this.#ready;
    check(!this.#root && !this.#opening, "BUSY");
    check(!this.#closed, "CLOSED");
    this.#opening = true;
    try {
      return await this.#serial(async () => {
        const generation = this.#generation;
        this.#guard(generation);
        const faultEpoch = this.#faultEpoch;
        this.#trace("master.read", [masterId]);
        const epoch = this.#connectionEpoch;
        const [record] = await this.#transport.send(readPacket([masterId]), { signal: this.#lifetime.signal });
        this.#connectionGuard(generation, epoch);
        const e = envelope(record.payload);
        this.#trace("master.header", [masterId]);
        this.#trace("master.key.derive", [masterId]);
        const deriving = masterCredentials(password, e.salt);
        password = undefined;
        const credentials = await deriving;
        this.#connectionGuard(generation, epoch);
        this.#trace("master.key.ready", [masterId]);
        const root = { id: masterId, ...(await this.#openRecord(credentials, record, undefined, "master")) };
        check(root.mode === "X", "UNSUPPORTED_PROFILE");
        const catalog = this.#catalog(root.data);
        this.#trace("master.catalog", [masterId], catalog.length);
        const resources = await this.#readContents(catalog);
        this.#connectionGuard(generation, epoch);
        this.#faultGuard(faultEpoch);
        this.#generation++;
        this.#root = root;
        this.#masterCredentials = credentials;
        this.#resources = resources;
        for (const [resourceId, r] of resources)
          this.#lanes.set(resourceId, this.#makeLane(r.state, r.credentials));
        this.#tree = dataTree(this, this.#generation);
        this.#status = "open";
        this.#trace("session.memory", [masterId], resources.size);
        return this.#tree;
      });
    } catch (e) {
      // A concurrent integrity fault requires a new read, not a new socket.
      if (e.code !== "NEEDS_RESYNC") this.#transport.disconnect();
      throw safeError(e);
    } finally {
      password = undefined;
      this.#opening = false;
    }
  }
  async #readContents(entries, fresh = false, signal = this.#lifetime.signal) {
    const map = new Map();
    if (!entries.length) return map;
    this.#trace("content.read", entries.map(x => x.id), entries.length);
    // Read/decrypt bounded batches; only publish the complete verified map.
    try {
      for (let start = 0; start < entries.length; start += LIMITS.batch) {
        const group = entries.slice(start, start + LIMITS.batch);
        const records = new Map((await this.#readRecords(group.map(x => x.id), signal)).map(r => [r.id, r]));
        for (const entry of group) {
          checkSignal(signal);
          const record = records.get(entry.id);
          const credentials = await contentCredentials(entry.key, envelope(record.payload).salt);
          this.#trace("content.key", [entry.id]);
          const state = {
            id: entry.id,
            ...(await this.#openRecord(credentials, record, entry.token)),
          };
          try { await this.#checkProgress(this.#resources.get(entry.id)?.state, state, fresh); }
          catch (error) { state.origin.fill(0); throw error; }
          map.set(entry.id, { state, credentials });
          this.#trace("content.staged", [entry.id]);
        }
      }
    } catch (error) {
      for (const resource of map.values()) resource.state.origin.fill(0);
      throw error;
    }
    return map;
  }
  async #readRecords(ids, signal = this.#lifetime.signal) {
    try {
      return await this.#transport.send(readPacket(ids), { signal });
    } catch (error) {
      if (error.code !== "LIMIT" || ids.length < 2) throw error;
      const middle = Math.ceil(ids.length / 2);
      return [
        ...(await this.#readRecords(ids.slice(0, middle), signal)),
        ...(await this.#readRecords(ids.slice(middle), signal)),
      ];
    }
  }
  snapshot() {
    this.#requireOpen();
    const data = Object.create(null);
    for (const e of this.#root.data.contents) {
      const r = this.#resources.get(e.id);
      if (r)
        Object.defineProperty(data, e.name, {
          value: json(r.state.data),
          enumerable: true,
        });
    }
    return data;
  }
  value(content, path = []) {
    const e = this.#entry(content);
    const r = this.#resources.get(e.id);
    check(r, "NOT_FOUND");
    return json(pathValue(r.state.data, path));
  }
  ref(content) {
    const resourceId = this.#entry(content).id, generation = this.#generation;
    // Capture identity only, never the catalog entry containing its secrets.
    const ensure = () => {
      check(this.#generation === generation, "STALE_REFERENCE");
      check(this.#resources.has(resourceId) && this.#root?.data.contents.some(
        entry => entry.id === resourceId && entry.name === content), "STALE_REFERENCE");
    };
    return reference(this, ensure, content);
  }
  update(content, value) {
    return this.set(content, [], value);
  }
  set(content, path, value) {
    this.#requireOpen(true);
    const e = this.#entry(content);
    check(Array.isArray(path));
    const input = json(value);
    const keys = [...path];
    const lane = this.#lanes.get(e.id);
    check(lane, "NOT_FOUND");
    this.#trace("write.queued", [e.id]);
    return lane.enqueue((data) => edit(data, keys, input));
  }
  remove(content, path) {
    this.#requireOpen(true);
    const e = this.#entry(content);
    check(Array.isArray(path));
    const keys = [...path];
    check(keys.length > 0, "UNSUPPORTED");
    const lane = this.#lanes.get(e.id);
    check(lane, "NOT_FOUND");
    return lane.enqueue((data) => edit(data, keys, null, true));
  }
  #masterTask(fn) {
    this.#requireOpen(true);
    check(this.#masterTasks < LIMITS.queue, "LIMIT");
    this.#masterTasks++;
    const generation = this.#generation;
    const task = this.#masterTail
      .then(() => {
        this.#guard(generation);
        this.#requireOpen(true);
        check(this.#catalogUnknown < 0, "NEEDS_RESYNC");
        return fn();
      })
      .finally(() => this.#masterTasks--);
    this.#masterTail = task.catch(() => {});
    return task;
  }
  add(content, value, mode = "X") {
    name(content);
    check(mode === "X" || mode === "S");
    const input = json(value);
    return this.#masterTask(async () => {
      const generation = this.#generation, faultEpoch = this.#faultEpoch;
      check(
        !this.#root.data.contents.some((x) => x.name === content),
        "EXISTS",
      );
      let pending = this.#adds.get(content);
      if (pending)
        check(
          pending.mode === mode &&
            JSON.stringify(pending.data) === JSON.stringify(input),
          "BUSY",
        );
      else {
        this.#trace("content.new");
        const key = newContentSecret(),
          token = newToken(),
          credentials = await contentCredentials(key),
          origin = newOrigin(mode);
        const sealed = await seal(credentials, token, origin, null);
        this.#trace("content.empty.sealed");
        this.#writeGuard(generation, faultEpoch);
        pending = {
          key,
          token,
          credentials,
          mode,
          data: input,
          state: { origin, token, data: null, ...inspect(origin) },
        };
        try {
          const [resourceId] = await this.#transport.send(
            writePacket("create", [{ sealed }]),
            { volatile: true, signal: this.#lifetime.signal },
          );
          pending.id = resourceId;
          this.#trace("content.id", [resourceId]);
          pending.state.id = resourceId;
          pending.state.record = { id: resourceId, ...sealedWire(sealed) };
          pending.state.witness = pending.state.record.witness;
        } catch (e) {
          if (!this.#closed && e.code === "UNKNOWN_OUTCOME") this.#catalogUnknown = Infinity;
          throw e;
        }
        this.#guard(generation);
        this.#adds.set(content, pending);
      }
      this.#writeGuard(generation, faultEpoch);
      const contentState = await this.#prepare(
        pending.state,
        pending.credentials,
        () => input,
      );
      this.#guard(generation);
      const masterState = await this.#prepare(
        this.#root,
        this.#masterCredentials,
        (data) => {
          check(
            !data.contents.some((entry) => entry.name === content),
            "EXISTS",
          );
          data.contents.push({
            id: pending.id,
            name: content,
            key: pending.key,
            token: pending.token,
          });
          this.#trace("catalog.link", [this.#root.id, pending.id]);
          this.#catalog(data);
          return data;
        },
      );
      this.#guard(generation);
      try {
        this.#trace("add.commit", [pending.id, this.#root.id]);
        this.#writeGuard(generation, faultEpoch);
        await this.#sendWrite(
          writePacket("update", [
            { id: pending.id, sealed: contentState.sealed },
            { id: this.#root.id, sealed: masterState.sealed },
          ]),
          [contentState, masterState],
        );
      } catch (e) {
        if (!this.#closed && e.code === "UNKNOWN_OUTCOME") {
          this.#catalogUnknown = masterState.age;
          this.#status = "needsResync";
        }
        throw e;
      }
      await this.#serial(async () => {
        this.#guard(generation);
        if (masterState.age >= this.#root.age) {
          await this.#checkProgress(this.#root, masterState);
          this.#root = masterState;
        }
        if (!this.#resources.has(pending.id) && this.#root.data.contents.some(e => e.id === pending.id && e.token === pending.token)) {
          const accepted = pending.received && pending.received.age > contentState.age ? pending.received : contentState;
          this.#resources.set(pending.id, {
            state: accepted,
            credentials: pending.credentials,
          });
          this.#lanes.set(
            pending.id,
            this.#makeLane(accepted, pending.credentials),
          );
        }
        this.#adds.delete(content);
        this.#forgetCandidates(this.#root.id, this.#root.age);
        this.#forgetCandidates(pending.id, this.#resources.get(pending.id)?.state.age ?? Infinity);
        this.#trace("add.memory", [pending.id, this.#root.id]);
      });
      // Successful Create/Update already subscribed this connection before ACK.
      // A disconnect after commit does not undo the write; reconnect will resync.
      this.#trace("content.subscribed", [pending.id]);
      return { ok: true, name: content, subscriptionReady: this.#transport.connected };
    });
  }
  async #changed(event) {
    if (this.#closed || !this.#root) return;
    this.#trace("changed.receive", [...event.updated.map(x => x.id), ...event.deleted]);
    const generation = this.#generation;
    const epoch = this.#connectionEpoch;
    const rootDeleted = event.deleted.includes(this.#root.id);
    const rootRecord = event.updated.find((x) => x.id === this.#root.id);
    let nextRoot = this.#root;
    if (rootRecord) {
      const next = {
        id: this.#root.id,
        ...(await this.#openRecord(this.#masterCredentials, rootRecord, this.#root.token, "master")),
      };
      if (next.age >= this.#root.age) {
        await this.#checkProgress(this.#root, next);
        this.#catalog(next.data);
        nextRoot = next;
      }
    }
    for (const entry of nextRoot.data.contents) {
      const old = this.#root.data.contents.find((x) => x.id === entry.id);
      if (old)
        check(
          entry.key === old.key && entry.token === old.token,
          "UNSUPPORTED_PROFILE",
        );
    }
    const staged = new Map(), pendingReceived = new Map();
    for (const record of event.updated) {
      const entry = nextRoot.data.contents.find((x) => x.id === record.id);
      if (!entry) {
        // Another client may already edit a newly linked content while our Add
        // ACK is delayed. Keep its authenticated state private until the local
        // catalog is committed; do not lose it just because the link is pending.
        const pending = [...this.#adds.values()].find(x => x.id === record.id);
        if (pending) {
          const next = { id: record.id, ...(await this.#openRecord(pending.credentials, record, pending.token)) };
          const previous = pending.received ?? pending.state;
          if (next.age >= previous.age) {
            await this.#checkProgress(previous, next);
            pendingReceived.set(pending, next);
          }
        }
        continue;
      }
      const credentials = await contentCredentials(entry.key, envelope(record.payload).salt);
      const next = {
        id: entry.id,
        ...(await this.#openRecord(credentials, record, entry.token)),
      };
      const previous = this.#resources.get(entry.id)?.state;
      if (previous && next.age < previous.age) continue;
      await this.#checkProgress(previous, next);
      staged.set(entry.id, { state: next, credentials });
    }
    if (rootDeleted) {
      // A deletion notice cannot bypass validation of known updated resources
      // in the same message. Do not destroy the last verified copy on failure.
      this.#connectionGuard(generation, epoch);
      await this.close();
      return;
    }
    const missing = nextRoot.data.contents.filter(
      (x) =>
        !this.#resources.has(x.id) &&
        !staged.has(x.id) &&
        !event.deleted.includes(x.id),
    );
    for (const [key, value] of await this.#readContents(missing))
      staged.set(key, value);
    this.#connectionGuard(generation, epoch);
    for (const [pending, next] of pendingReceived) pending.received = next;
    this.#root = nextRoot;
    this.#forgetCandidates(nextRoot.id, nextRoot.age);
    const keep = new Set(nextRoot.data.contents.map((x) => x.id));
    for (const resourceId of this.#resources.keys())
      if (!keep.has(resourceId) || event.deleted.includes(resourceId)) {
        this.#lanes.get(resourceId)?.close();
        this.#lanes.delete(resourceId);
        this.#resources.delete(resourceId);
        this.#forgetCandidates(resourceId);
      }
    for (const [resourceId, r] of staged) {
      this.#resources.set(resourceId, r);
      this.#forgetCandidates(resourceId, r.state.age);
      if (!this.#lanes.has(resourceId))
        this.#lanes.set(resourceId, this.#makeLane(r.state, r.credentials));
      else this.#lanes.get(resourceId).observe(r.state);
    }
    this.#emit("change", { ids: [...staged.keys()], kind: "updated" });
    this.#trace("changed.memory", [...staged.keys(), ...event.deleted]);
    if (event.deleted.length)
      this.#emit("change", { ids: [...event.deleted], kind: "deleted" });
  }
  async refresh() {
    check(!this.#recovery.running, "BUSY");
    return this.#refresh();
  }
  async #refresh(signal = this.#lifetime.signal) {
    this.#requireOpen();
    check(
      !this.#masterTasks && ![...this.#lanes.values()].some((l) => l.active),
      "BUSY",
    );
    return this.#serial(async () => {
      const generation = this.#generation;
      const epoch = this.#connectionEpoch;
      this.#connectionGuard(generation, epoch, signal);
      const faultEpoch = this.#faultEpoch;
      this.#trace("refresh.begin", [this.#root.id]);
      this.#trace("master.read", [this.#root.id]);
      const [record] = await this.#transport.send(readPacket([this.#root.id]), { signal });
      const next = {
        id: this.#root.id,
        ...(await this.#openRecord(this.#masterCredentials, record, this.#root.token, "master")),
      };
      await this.#checkProgress(this.#root, next, true);
      this.#trace("master.catalog", [this.#root.id], this.#catalog(next.data).length);
      const resources = await this.#readContents(
        this.#catalog(next.data),
        true,
        signal,
      );
      this.#connectionGuard(generation, epoch, signal);
      // Never let a read started before a new fault clear its write barrier.
      this.#faultGuard(faultEpoch);
      this.#root = next;
      this.#forgetCandidates(next.id, next.age);
      for (const [resourceId, lane] of this.#lanes)
        if (!resources.has(resourceId)) {
          lane.close();
          this.#lanes.delete(resourceId);
          this.#forgetCandidates(resourceId);
        }
      this.#resources = resources;
      for (const [resourceId, r] of resources) {
        this.#forgetCandidates(resourceId, r.state.age);
        if (!this.#lanes.has(resourceId))
          this.#lanes.set(resourceId, this.#makeLane(r.state, r.credentials));
        else this.#lanes.get(resourceId).observe(r.state, { refresh: true });
      }
      if (next.age >= this.#catalogUnknown) this.#catalogUnknown = -1;
      for (const [content, pending] of this.#adds)
        if (
          next.data.contents.some(
            (entry) =>
              entry.name === content &&
              entry.id === pending.id &&
              entry.token === pending.token,
          )
        )
          this.#adds.delete(content);
      this.#status =
        !this.#repair &&
        this.#catalogUnknown < 0 &&
        ![...this.#lanes.values()].some((l) => l.blocked)
          ? "open"
          : "needsResync";
      this.#trace("refresh.memory", [this.#root.id], resources.size);
      this.#emit("status", this.#status);
      this.#connectionGuard(generation, epoch, signal);
      return this.#tree;
    }).catch(error => {
      const clean = safeError(error);
      // Match the fail-closed behavior of Changed while retaining readable data.
      // A concurrent disconnect keeps its own status; close never reopens state.
      if (this.#transport.connected && !signal?.aborted) this.#fault(clean);
      throw clean;
    });
  }
  reconnect() {
    if (this.#closed) return Promise.reject(new UldaError("CLOSED"));
    const running = this.#recovery.running;
    const task = this.#recovery.run();
    if (!running) {
      this.#status = "reconnecting";
      for (const lane of this.#lanes.values()) lane.stop();
      this.#emit("status", this.#status);
    }
    this.#ready = task.then(() => {});
    this.#ready.catch(() => {});
    return task;
  }
  // Explicit recovery only. The source is a confirmed SDK snapshot, never an
  // unverified reply or an unacknowledged write candidate supplied by an app.
  async recoverContent(content) {
    this.#requireOpen();
    name(content);
    check(this.#transport.connected, "OFFLINE");
    check(!this.#exclusive && !this.#recovery.running && !this.#masterTasks &&
      ![...this.#lanes.values()].some(lane => lane.active), "BUSY");
    check(!this.#repair || this.#repair.content === content, "BUSY");
    check(this.#catalogUnknown < 0 && !this.#adds.size &&
      (this.#repair || !this.#sentCandidates.size), "NEEDS_RESYNC");
    this.#exclusive = true;
    let finishExclusive;
    this.#exclusiveDone = new Promise(resolve => { finishExclusive = resolve; });
    try {
      return await this.#serial(async () => {
        const generation = this.#generation, epoch = this.#connectionEpoch;
        const faultEpoch = this.#faultEpoch;
        const guard = () => this.#connectionGuard(generation, epoch, this.#lifetime.signal);
        guard();
        let plan = this.#repair;
        if (!plan) {
          const entry = this.#entry(content), source = this.#resources.get(entry.id)?.state;
          check(source, "NOT_FOUND");
          plan = { content, entry: json(entry), source: json(source.data), sourceAge: source.age,
            mode: source.mode, phase: "prepared" };
          this.#repair = plan;
        }
        this.#status = "needsResync";
        for (const lane of this.#lanes.values()) lane.stop();
        this.#trace("repair.begin", [plan.entry.id]);
        guard();
        // No ID was received: a Read cannot discover the reserved record.
        check(plan.phase !== "createUnknown", "UNKNOWN_OUTCOME");
        const [record] = await this.#transport.send(readPacket([this.#root.id]), { signal: this.#lifetime.signal });
        guard();
        const root = { id: this.#root.id, ...(await this.#openRecord(this.#masterCredentials, record, this.#root.token, "master")) };
        await this.#checkProgress(this.#root, root, true);
        const catalog = this.#catalog(root.data), link = catalog.find(entry => entry.name === content);
        const matches = (entry, expected) => entry?.id === expected.id && entry.key === expected.key && entry.token === expected.token;
        guard();
        if (plan.id && matches(link, { id: plan.id, key: plan.key, token: plan.token })) {
          check(plan.candidate && ["commitUnknown", "committed"].includes(plan.phase), "CONFLICT");
          await this.#checkProgress(plan.master, root, true);
          const resources = await this.#readContents(catalog, true);
          await this.#checkProgress(plan.candidate, resources.get(plan.id).state, true);
          guard();
          const result = this.#publishRepair(plan, root, resources, faultEpoch, true);
          this.#trace("repair.resolved", [result.previousId, result.id]);
          return result;
        }
        // Even an old Read does not prove that a timed-out commit cannot finish
        // later. Do not replay an unknown write or allocate another resource.
        check(!["commitUnknown", "committed"].includes(plan.phase), "UNKNOWN_OUTCOME");
        check(matches(link, plan.entry), "CONFLICT");
        const resources = await this.#readContents(catalog.filter(entry => entry.id !== plan.entry.id), true);
        guard();
        this.#trace("repair.checked", [root.id, plan.entry.id]);
        guard();
        if (plan.id) {
          const [reserved] = await this.#transport.send(readPacket([plan.id]), { signal: this.#lifetime.signal });
          guard();
          // A known failed atomic Update leaves this exact empty reservation.
          // Do not overwrite an independently changed or deleted reservation.
          check(equal(reserved.witness, plan.base.record.witness) &&
            equal(reserved.payload, plan.base.record.payload), "CONFLICT");
        } else {
          if (!plan.base) {
            plan.key = newContentSecret(); plan.token = newToken();
            plan.credentials = await contentCredentials(plan.key);
            guard();
            const origin = newOrigin(plan.mode);
            plan.base = { origin, token: plan.token, data: null, ...inspect(origin) };
          }
          if (!plan.empty) {
            plan.empty = await seal(plan.credentials, plan.token, plan.base.origin, null);
            guard();
          }
          this.#trace("repair.reserve");
          guard();
          this.#writeGuard(generation, faultEpoch);
          try {
            const [resourceId] = await this.#transport.send(writePacket("create", [{ sealed: plan.empty }]),
              { volatile: true, signal: this.#lifetime.signal });
            this.#guard(generation);
            // Treat a colliding ID as an unusable Create ACK, not as permission
            // to overwrite a resource already known to this context.
            plan.phase = "createUnknown";
            check(resourceId !== root.id && !catalog.some(entry => entry.id === resourceId), "UNKNOWN_OUTCOME");
            plan.id = resourceId;
            const wire = sealedWire(plan.empty);
            Object.assign(plan.base, { id: resourceId, witness: wire.witness, record: { id: resourceId, ...wire } });
            plan.phase = "reserved";
          } catch (error) {
            if (error.code === "UNKNOWN_OUTCOME" && !this.#closed) plan.phase = "createUnknown";
            throw error;
          }
          guard();
        }
        plan.candidate = await this.#prepare(plan.base, plan.credentials, () => plan.source);
        guard();
        plan.master = await this.#prepare(root, this.#masterCredentials, data => {
          const entry = data.contents.find(entry => entry.name === content);
          check(matches(entry, plan.entry), "CONFLICT");
          Object.assign(entry, { id: plan.id, key: plan.key, token: plan.token });
          this.#catalog(data);
          return data;
        });
        guard();
        this.#trace("repair.commit", [plan.id, root.id]);
        guard();
        this.#writeGuard(generation, faultEpoch);
        try {
          await this.#sendWrite(writePacket("update", [
            { id: plan.id, sealed: plan.candidate.sealed },
            { id: root.id, sealed: plan.master.sealed },
          ]), [plan.candidate, plan.master]);
          plan.phase = "committed";
        } catch (error) {
          if (!this.#closed) plan.phase = error.code === "UNKNOWN_OUTCOME" ? "commitUnknown" : "reserved";
          throw error;
        }
        this.#guard(generation);
        resources.set(plan.id, { state: plan.candidate, credentials: plan.credentials });
        return this.#publishRepair(plan, plan.master, resources, faultEpoch, false);
      });
    } catch (error) {
      if (!this.#closed && this.#repair && this.#transport.connected) this.#fault(error);
      throw safeError(error);
    } finally { this.#exclusive = false; finishExclusive(); }
  }
  #publishRepair(plan, root, resources, faultEpoch, reconciled) {
    const result = Object.freeze({ ok: true, previousId: plan.entry.id, id: plan.id,
      sourceAge: plan.sourceAge, reconciled });
    for (const lane of this.#lanes.values()) lane.close();
    this.#lanes.clear();
    this.#root = root;
    this.#resources = resources;
    this.#sentCandidates.clear();
    for (const [resourceId, resource] of resources)
      this.#lanes.set(resourceId, this.#makeLane(resource.state, resource.credentials));
    this.#clearRepair();
    this.#status = !this.#transport.connected ? "disconnected" :
      this.#faultEpoch === faultEpoch ? "open" : "needsResync";
    this.#trace("repair.memory", [result.previousId, result.id, root.id]);
    if (!this.#closed) this.#emit("change", { ids: [result.previousId, result.id], kind: "recovered" });
    if (!this.#closed) this.#emit("status", this.#status);
    return result;
  }
  #clearRepair() {
    const plan = this.#repair;
    if (!plan) return;
    const retained = new Set([this.#root?.origin, ...[...this.#resources.values()].map(r => r.state.origin)]);
    for (const state of [plan.base, plan.candidate, plan.master])
      if (state && !retained.has(state.origin)) state.origin.fill(0);
    this.#repair = undefined;
  }
  async delete(content) {
    this.#requireOpen(true);
    name(content);
    check(!this.#masterTasks && ![...this.#lanes.values()].some(l => l.active), "BUSY");
    this.#exclusive = true;
    let finishExclusive;
    this.#exclusiveDone = new Promise(resolve => { finishExclusive = resolve; });
    try {
      const faultEpoch = this.#faultEpoch;
      this.#trace("delete.begin");
      await this.refresh();
      const entry = this.#entry(content);
      const state = this.#resources.get(entry.id)?.state;
      check(state, "NOT_FOUND");
      const generation = this.#generation;
      const proof = await deletionProof(entry.id, state.origin);
      this.#trace("delete.proof", [entry.id]);
      const masterState = await this.#prepare(this.#root, this.#masterCredentials, data => {
        data.contents = data.contents.filter(x => x.id !== entry.id);
        this.#trace("catalog.unlink", [this.#root.id, entry.id]);
        return data;
      });
      this.#guard(generation);
      this.#trace("delete.commit", [entry.id, this.#root.id]);
      try {
        this.#writeGuard(generation, faultEpoch);
        await this.#sendWrite(deletePacket([proof], [{ id: this.#root.id, sealed: masterState.sealed }]), [masterState]);
      } catch (error) {
        if (!this.#closed) {
          if (error.code === "UNKNOWN_OUTCOME") this.#catalogUnknown = masterState.age;
          this.#status = "needsResync";
          this.#trace("resync.required");
        }
        throw error;
      }
      await this.#serial(async () => {
        this.#guard(generation);
        if (masterState.age >= this.#root.age) {
          await this.#checkProgress(this.#root, masterState);
          this.#root = masterState;
        }
        this.#lanes.get(entry.id)?.close();
        this.#lanes.delete(entry.id);
        this.#resources.delete(entry.id);
        this.#forgetCandidates(entry.id);
        this.#forgetCandidates(this.#root.id, this.#root.age);
        this.#trace("delete.memory", [entry.id, this.#root.id]);
        this.#emit("change", { ids: [entry.id], kind: "deleted" });
      });
      return { ok: true };
    } finally { this.#exclusive = false; finishExclusive(); }
  }
  async superDelete() {
    this.#requireOpen(true);
    check(
      !this.#masterTasks && ![...this.#lanes.values()].some((l) => l.active),
      "BUSY",
    );
    this.#exclusive = true;
    let finishExclusive;
    this.#exclusiveDone = new Promise(resolve => { finishExclusive = resolve; });
    try {
      const faultEpoch = this.#faultEpoch;
      this.#trace("superdelete.begin", [this.#root.id]);
      await this.refresh();
      const states = [...this.#resources.values()].map((r) => r.state);
      states.push(this.#root);
      const generation = this.#generation;
      const proofs = [];
      for (const state of states)
        proofs.push(await deletionProof(state.id, state.origin));
      this.#guard(generation);
      try {
        this.#trace("superdelete.commit", states.map(x => x.id), states.length);
        this.#writeGuard(generation, faultEpoch);
        await this.#transport.send(deletePacket(proofs), { volatile: true, signal: this.#lifetime.signal });
      } catch (e) {
        if (!this.#closed && e.code === "UNKNOWN_OUTCOME") {
          this.#catalogUnknown = Infinity;
          this.#status = "needsResync";
        }
        throw e;
      }
      await this.close();
      return { ok: true };
    } finally {
      this.#exclusive = false;
      finishExclusive();
    }
  }
  close() {
    if (this.#closing) return this.#closing;
    let resolve, reject;
    this.#closing = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.#finishClose().then(resolve, reject);
    return this.#closing;
  }
  async #finishClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#recovery.cancel("CLOSED");
    this.#status = "closed";
    this.#generation++;
    this.#lifetime.abort(new UldaError("CLOSED"));
    for (const off of this.#transportOff.splice(0)) {
      try { off?.(); } catch { /* Cleanup must not depend on a custom observer. */ }
    }
    // Only SDK-owned origins; public data snapshots are independent copies.
    const wipe = state => state?.origin?.fill(0);
    wipe(this.#root);
    for (const { state } of this.#resources.values()) wipe(state);
    for (const states of this.#sentCandidates.values()) for (const state of states) wipe(state);
    for (const pending of this.#adds.values()) { wipe(pending.state); wipe(pending.received); }
    this.#clearRepair();
    for (const l of this.#lanes.values()) l.close();
    this.#root = undefined;
    this.#masterCredentials = undefined;
    this.#resources.clear();
    this.#lanes.clear();
    this.#sentCandidates.clear();
    this.#adds.clear();
    this.#tree = undefined;
    this.#trace("session.clear");
    try {
      if (this.#transport.connected)
        await this.#transport.send(emptyPacket("session.close"));
    } catch {
      /* Closing cannot roll back accepted writes. */
    } finally {
      this.#transport.close();
      this.#trace("session.closed");
      this.#emit("status", "closed");
      for (const listeners of this.#listeners.values()) listeners.clear();
      this.#listeners.clear();
    }
  }
}
