import { io } from "socket.io-client";
import { check, UldaError, safeError } from "./errors.js";
import {
  outgoing,
  requestShape,
  acknowledgement,
  changed,
  resource,
} from "./protocol.js";
import { LIMITS, binary, equal, exact } from "./values.js";
import { needsTransfer, fragments, ChangeAssembly } from './transfer.js';
import { serverDiagnostic } from "./diagnostics.js";
import { socketParser } from "./socket-parser.js";
import { checkSignal } from "./reconnect.js";

// Trace records are built from an allowlist, never from raw packets/errors.
// Lengths describe binary fields, not total WebSocket traffic.
function resourceSummary(items) {
  return items.map((item) => ({
    ...(item.id === undefined ? {} : { id: item.id }),
    witnessBytes: item.witness.byteLength,
    ...(item.payload === undefined ? {} : {
      payloadBytes: item.payload.byteLength,
    }),
  }));
}
function freezeTrace(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTrace);
    Object.freeze(value);
  }
  return value;
}

export class SocketIoTransport {
  #socket;
  #timeout;
  #pending = new Set();
  #listeners = new Map();
  #closed = false;
  #opening;
  #generation = 0;
  #request = 0;
  #intentional = false;
  #writeTail = Promise.resolve();
  #readTail = Promise.resolve();
  #transfers = 0;
  #assembly;
  #assemblyTimer;
  constructor(
    endpoint,
    { timeout = 10_000, allowInsecureLocalhost = false, diagnostics = false } = {},
  ) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      check(false);
    }
    check(!url.username && !url.password && !url.search && !url.hash);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    check(
      url.protocol === "https:" ||
        (allowInsecureLocalhost && local && url.protocol === "http:"),
    );
    check(Number.isSafeInteger(timeout) && timeout >= 50 && timeout <= 60_000);
    this.#timeout = timeout;
    this.#socket = io(url.href, {
      autoConnect: false,
      forceNew: true,
      multiplex: false,
      transports: ["websocket"],
      parser: socketParser,
      reconnection: false,
      retries: 0,
      timeout,
      withCredentials: false,
      auth: { uldaTransfer: 1 },
    });
    if (diagnostics) this.#socket.on("ulda:diagnostic", raw => {
      try {
        const record = serverDiagnostic(raw);
        this.#trace(() => ({ phase: "server", ...record }));
      } catch {
        // Diagnostic input cannot change protocol state or echo arbitrary server data.
      }
    });
    this.#socket.on("disconnect", () => {
      clearTimeout(this.#assemblyTimer); this.#assembly = undefined;
      this.#trace(() => ({ phase: "connection", event: "disconnect" }));
      this.#generation++;
      this.#rejectPending();
      this.#notify("disconnect", { intentional: this.#intentional || this.#closed });
    });
    this.#socket.on('ulda:changed.part', raw => {
      try {
        if (raw?.kind === 'begin') {
          exact(raw, ['kind', 'count']);
          check(!this.#assembly, 'INVALID_PACKET');
          this.#assembly = new ChangeAssembly(raw.count);
          this.#assemblyTimer = setTimeout(() => {
            this.#assembly = undefined;
            this.#notify('error', new UldaError('TIMEOUT'));
          }, this.#timeout);
        } else {
          check(this.#assembly, 'INVALID_PACKET');
          if (raw?.kind === 'end') {
            exact(raw, ['kind']);
            const value = changed(this.#assembly.finish(), true);
            clearTimeout(this.#assemblyTimer); this.#assembly = undefined;
            this.#notify('changed', value);
          } else this.#assembly.accept(raw);
        }
      } catch {
        clearTimeout(this.#assemblyTimer); this.#assembly = undefined;
        this.#notify('error', new UldaError('INVALID_PACKET'));
      }
    });
    this.#socket.on("ulda:changed", (raw) => {
      try {
        check(!this.#assembly, 'INVALID_PACKET');
        const value = changed(raw);
        this.#trace(() => ({
          phase: "push", event: "ulda:changed",
          updated: resourceSummary(value.updated), deleted: [...value.deleted],
        }));
        this.#notify("changed", value);
      } catch {
        this.#trace(() => ({ phase: "push", event: "ulda:changed", code: "INVALID_PACKET" }));
        this.#notify("error", new UldaError("INVALID_PACKET"));
      }
    });
  }
  get connected() {
    return this.#socket.connected && !this.#closed;
  }
  on(event, listener) {
    check(
      ["changed", "disconnect", "error", "trace"].includes(event) &&
        typeof listener === "function",
    );
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return () => set.delete(listener);
  }
  #notify(event, value) {
    for (const fn of this.#listeners.get(event) ?? []) {
      try {
        fn(value);
      } catch {
        /* User callbacks cannot interfere with protocol state. */
      }
    }
  }
  #trace(makeRecord) {
    if (!this.#listeners.get("trace")?.size) return;
    try {
      this.#notify("trace", freezeTrace({ time: Date.now(), ...makeRecord() }));
    } catch {
      /* Optional diagnostics must never affect the protocol. */
    }
  }
  #rejectPending() {
    for (const reject of [...this.#pending]) reject();
  }
  async start({ signal } = {}) {
    checkSignal(signal);
    check(!this.#closed, "CLOSED");
    if (this.connected) return;
    if (this.#opening) return this.#opening;
    this.#trace(() => ({ phase: "connection", event: "connecting" }));
    this.#opening = new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.#socket.off("connect", connected);
        this.#socket.off("connect_error", failed);
        this.#pending.delete(stopped);
        this.#trace(() => ({
          phase: "connection", event: error ? "connect_failed" : "connect",
          ...(error ? { code: error.code } : {}),
        }));
        error ? reject(error) : resolve();
      };
      const connected = () => finish();
      const failed = () => finish(new UldaError("OFFLINE"));
      const stopped = () => finish(new UldaError("CLOSED"));
      const aborted = () => {
        finish(signal.reason);
        this.#socket.disconnect();
      };
      const timer = setTimeout(() => {
        finish(new UldaError("TIMEOUT"));
        this.#socket.disconnect();
      }, this.#timeout);
      signal?.addEventListener("abort", aborted, { once: true });
      this.#pending.add(stopped);
      this.#socket.once("connect", connected);
      this.#socket.once("connect_error", failed);
      this.#socket.connect();
    });
    try {
      await this.#opening;
    } finally {
      this.#opening = undefined;
    }
  }
  async send(packet, { volatile = false, signal } = {}) {
    checkSignal(signal);
    const { action, body } = outgoing(packet);
    requestShape(action, body, true);
    if (['create', 'update', 'delete'].includes(action) && needsTransfer(body)) {
      return this.#queued('write', () => this.#writeTransfer(action, body, signal));
    }
    try {
      return await this.#sendWire(action, body, { volatile, signal });
    } catch (error) {
      if (action === 'read' && body.length === 1 && error.code === 'LIMIT') {
        return this.#queued('read', () => this.#readTransfer(body[0], signal));
      }
      if (['create', 'update', 'delete'].includes(action) && error.code === 'LIMIT') {
        return this.#queued('write', () => this.#writeTransfer(action, body, signal));
      }
      throw error;
    }
  }
  #queued(kind, work) {
    check(this.#transfers < LIMITS.queue, 'LIMIT');
    this.#transfers++;
    const generation = this.#generation;
    const task = (kind === 'write' ? this.#writeTail : this.#readTail).then(() => {
      check(generation === this.#generation, 'OFFLINE'); return work();
    });
    const tail = task.then(() => {}, () => {}).finally(() => this.#transfers--);
    if (kind === 'write') this.#writeTail = tail; else this.#readTail = tail;
    return task;
  }
  async #writeTransfer(action, body, signal) {
    let token;
    try {
      token = await this.#sendWire('transfer', { kind: 'begin', action, count: body.length }, { signal }, raw => {
        if (raw?.ok === false) acknowledgement('hello', {}, raw);
        exact(raw, ['ok', 'token']); check(raw.ok === true && /^[a-f0-9]{32}$/.test(raw.token), 'INVALID_PACKET');
        return raw.token;
      });
      for (const frame of fragments(body)) await this.#sendWire('transfer', { ...frame, token }, { signal });
      return await this.#sendWire('transfer', { kind: 'commit', token }, { signal, commit: true, volatile: true }, raw => acknowledgement(action, body, raw, true));
    } catch (error) {
      // No replay. Closing discards any uncommitted staging. A lost commit ACK
      // keeps UNKNOWN_OUTCOME even if the connection is subsequently closed.
      if (token || error.code === 'TIMEOUT' || error.code === 'INVALID_PACKET') this.disconnect();
      throw error;
    }
  }
  async #readTransfer(id, signal) {
    let result, offset = 0;
    try { do {
      const part = await this.#sendWire('transfer', { kind: 'read', resourceId: id, offset }, { signal }, raw => {
        if (raw?.ok === false) acknowledgement('hello', {}, raw);
        exact(raw, ['ok', 'data']); check(raw.ok === true, 'INVALID_PACKET');
        const p = raw.data; exact(p, ['id', 'witness', 'payload', 'total', 'offset']);
        check(p.id === id && p.offset === offset, 'INVALID_PACKET');
        check(Number.isSafeInteger(p.total) && p.total > 0 && p.total <= LIMITS.resourceBytes, 'LIMIT');
        const witness = binary(p.witness, 167), payload = binary(p.payload, LIMITS.jsonBytes);
        check(offset + payload.length <= p.total, 'INVALID_PACKET');
        return { ...p, witness, payload };
      });
      if (!result) result = { id, witness: part.witness.slice(), payload: new Uint8Array(part.total) };
      check(result.payload.length === part.total && equal(result.witness, part.witness), 'INVALID_PACKET');
      result.payload.set(part.payload, offset); offset += part.payload.length;
    } while (offset < result.payload.length);
    return [resource(result)];
    } catch (error) {
      // Release the server's pinned encrypted snapshot on a failed assembly.
      this.disconnect();
      throw error;
    }
  }
  async #sendWire(action, body, { volatile = false, signal, commit = false } = {}, decode = raw => acknowledgement(action, body, raw)) {
    checkSignal(signal);
    check(!this.#closed, "CLOSED");
    check(this.connected, "OFFLINE");
    check(this.#pending.size < LIMITS.queue, "LIMIT");
    const generation = this.#generation;
    const write = commit || ["create", "update", "delete"].includes(action);
    const tracing = !!this.#listeners.get("trace")?.size;
    const request = tracing ? ++this.#request : 0;
    const started = tracing ? performance.now() : 0;
    const event = `ulda:${action}`;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value, received = false) => {
        if (done) return;
        done = true;
        this.#pending.delete(stopped);
        signal?.removeEventListener("abort", aborted);
        if (tracing) this.#trace(() => ({
          phase: received ? "ack" : "failure", event, request,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          ...(error ? { code: error.code } : { ok: true }),
          ...(!error && action === "read" ? { items: resourceSummary(value) } : {}),
          ...(!error && action === "create" ? { ids: [...value] } : {}),
        }));
        error ? reject(error) : resolve(value);
      };
      const stopped = () =>
        finish(new UldaError(write ? "UNKNOWN_OUTCOME" : "OFFLINE"));
      const aborted = () => finish(new UldaError(write ? "UNKNOWN_OUTCOME" : signal.reason.code));
      signal?.addEventListener("abort", aborted, { once: true });
      this.#pending.add(stopped);
      const sender = this.#socket.timeout(this.#timeout);
      if (volatile) sender.volatile;
      if (tracing) this.#trace(() => ({
        phase: "send", event, request, volatile: !!volatile,
        ...(action === "read" ? { ids: [...body] } : {}),
        ...(write && Array.isArray(body) ? { items: resourceSummary(body) } : {}),
        ...(action === 'transfer' ? { step: body.kind } : {}),
      }));
      sender.emit(event, body, (error, raw) => {
        if (done) return;
        if (error || generation !== this.#generation)
          return finish(new UldaError(write ? "UNKNOWN_OUTCOME" : "TIMEOUT"));
        try {
          finish(undefined, decode(raw), true);
        } catch (e) {
          const clean = safeError(e);
          finish(
            write &&
              (raw?.ok !== false ||
                clean.code === "INVALID_PACKET" ||
                clean.code === "INVALID_INPUT")
              ? new UldaError("UNKNOWN_OUTCOME")
              : clean,
            undefined,
            true,
          );
        }
      });
    });
  }
  disconnect() {
    const connected = this.connected;
    this.#intentional = true;
    try { this.#socket.disconnect(); }
    finally { this.#intentional = false; }
    if (!connected && !this.#closed) {
      this.#generation++;
      this.#rejectPending();
      this.#notify("disconnect", { intentional: true });
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#assemblyTimer); this.#assembly = undefined;
    this.#generation++;
    this.#rejectPending();
    this.#socket.disconnect();
    this.#socket.removeAllListeners();
    this.#trace(() => ({ phase: "connection", event: "closed" }));
    this.#listeners.clear();
  }
}
