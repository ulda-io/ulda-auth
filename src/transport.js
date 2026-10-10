import { io } from "socket.io-client";
import { check, UldaError, safeError } from "./errors.js";
import {
  outgoing,
  requestShape,
  acknowledgement,
  changed,
} from "./protocol.js";
import { LIMITS } from "./values.js";
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
      this.#trace(() => ({ phase: "connection", event: "disconnect" }));
      this.#generation++;
      this.#rejectPending();
      this.#notify("disconnect", { intentional: this.#intentional || this.#closed });
    });
    this.#socket.on("ulda:changed", (raw) => {
      try {
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
    requestShape(action, body);
    check(!this.#closed, "CLOSED");
    check(this.connected, "OFFLINE");
    check(this.#pending.size < LIMITS.queue, "LIMIT");
    const generation = this.#generation;
    const write = ["create", "update", "delete"].includes(action);
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
        ...(write ? { items: resourceSummary(body) } : {}),
      }));
      sender.emit(event, body, (error, raw) => {
        if (done) return;
        if (error || generation !== this.#generation)
          return finish(new UldaError(write ? "UNKNOWN_OUTCOME" : "TIMEOUT"));
        try {
          finish(undefined, acknowledgement(action, body, raw), true);
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
    this.#generation++;
    this.#rejectPending();
    this.#socket.disconnect();
    this.#socket.removeAllListeners();
    this.#trace(() => ({ phase: "connection", event: "closed" }));
    this.#listeners.clear();
  }
}
