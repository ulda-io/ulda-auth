import { UldaError, check } from "./errors.js";
import { LIMITS, equal } from "./values.js";

// Outbound preparation is serial; acknowledgement processing never waits behind it.
export class WriteLane {
  #confirmed;
  #working;
  #waiting = [];
  #pending = new Map();
  #busy = false;
  #blocked = false;
  #closed = false;
  #unknownAge = -1;
  #prepare;
  #send;
  #accept;
  #idle = new Set();
  #preparing;
  constructor(state, prepare, send, accept) {
    this.#confirmed = this.#working = state;
    this.#prepare = prepare;
    this.#send = send;
    this.#accept = accept;
  }
  get active() {
    return this.#busy || this.#waiting.length > 0 || this.#pending.size > 0;
  }
  get blocked() {
    return this.#blocked;
  }
  idle() {
    return this.active ? new Promise(resolve => this.#idle.add(resolve)) : Promise.resolve();
  }
  #notifyIdle() {
    if (this.active) return;
    for (const resolve of this.#idle) resolve();
    this.#idle.clear();
  }
  enqueue(change) {
    check(!this.#closed, "CLOSED");
    check(!this.#blocked, "NEEDS_RESYNC");
    check(this.#waiting.length + this.#pending.size < LIMITS.queue, "LIMIT");
    return new Promise((resolve, reject) => {
      this.#waiting.push({ change, resolve, reject });
      this.#pump();
    });
  }
  #rejectWaiting(code) {
    for (const j of this.#waiting.splice(0)) j.reject(new UldaError(code));
  }
  observe(state, { refresh = false } = {}) {
    if (this.#closed) return;
    if (state.age < this.#confirmed.age) return;
    const ours = [...this.#pending.values()].some(
      (j) =>
        equal(j.state.record.witness, state.record.witness) &&
        equal(j.state.record.payload, state.record.payload),
    );
    const same =
      equal(this.#confirmed.record.witness, state.record.witness) &&
      equal(this.#confirmed.record.payload, state.record.payload);
    this.#confirmed = state;
    if (!ours && !same && this.active) {
      this.#blocked = true;
      this.#rejectWaiting("CONFLICT");
    }
    if (!this.active) this.#working = state;
    if (refresh && !this.active && state.age >= this.#unknownAge) {
      this.#blocked = false;
      this.#working = state;
    }
    this.#pump();
  }
  async #pump() {
    if (this.#busy || this.#blocked || this.#closed || !this.#waiting.length)
      return;
    if (
      this.#working.mode === "X"
        ? this.#pending.size > 0
        : this.#working.age + 1 - this.#confirmed.age >= this.#working.N
    )
      return;
    this.#busy = true;
    const job = this.#waiting.shift();
    this.#preparing = job;
    try {
      const base = this.#working;
      const preparing = this.#prepare(base, job.change);
      job.change = undefined;
      const state = await preparing;
      if (this.#closed) throw new UldaError("CLOSED");
      if (this.#blocked || base !== this.#working)
        throw new UldaError("NEEDS_RESYNC");
      job.state = state;
      this.#working = state;
      this.#pending.set(state.record.witness, job);
      // Do not await here: S can prepare the next candidate while ACK is pending.
      this.#send(state)
        .then(async () => {
          if (this.#closed) throw new UldaError("CLOSED");
          await this.#accept(state);
          this.#pending.delete(state.record.witness);
          if (!this.#pending.size && !this.#busy)
            this.#working = this.#confirmed;
          job.resolve({ ok: true });
        })
        .catch((error) => {
          this.#pending.delete(state.record.witness);
          if (error.code === "UNKNOWN_OUTCOME")
            this.#unknownAge = Math.max(this.#unknownAge, state.age);
          this.#blocked = true;
          this.#rejectWaiting("NEEDS_RESYNC");
          job.reject(error);
        })
        .finally(() => {
          this.#pending.delete(state.record.witness);
          if (!this.#pending.size && !this.#busy)
            this.#working = this.#confirmed;
          this.#pump();
          this.#notifyIdle();
        });
    } catch (error) {
      job.reject(error);
    } finally {
      this.#preparing = undefined;
      this.#busy = false;
      this.#pump();
      this.#notifyIdle();
    }
  }
  stop(code = "NEEDS_RESYNC") {
    this.#blocked = true;
    this.#rejectWaiting(code);
    this.#notifyIdle();
  }
  close() {
    this.#closed = true;
    this.#preparing?.reject(new UldaError("CLOSED"));
    this.#rejectWaiting("CLOSED");
    for (const j of this.#pending.values()) j.reject(new UldaError("CLOSED"));
    this.#pending.clear();
    this.#confirmed = this.#working = undefined;
    this.#prepare = this.#send = this.#accept = undefined;
    this.#notifyIdle();
  }
}
