import { check, UldaError, safeError } from './errors.js';

const defaults = Object.freeze({ maxAttempts: 5, initialDelay: 500, maxDelay: 5000, jitter: 0.2, budget: 30000 });

export function reconnectOptions(value) {
  if (value === false) return { ...defaults, automatic: false };
  const input = value ?? {};
  check(input && typeof input === 'object' && !Array.isArray(input));
  check(Object.keys(input).every(key => Object.hasOwn(defaults, key)));
  const options = { ...defaults, ...input };
  for (const key of ['maxAttempts', 'initialDelay', 'maxDelay', 'budget']) check(Number.isSafeInteger(options[key]));
  check(options.maxAttempts >= 1 && options.maxAttempts <= 20);
  check(options.initialDelay >= 10 && options.maxDelay >= options.initialDelay && options.maxDelay <= 60000);
  check(options.budget >= 50 && options.budget <= 300000);
  check(Number.isFinite(options.jitter) && options.jitter >= 0 && options.jitter <= 1);
  return { ...options, automatic: true };
}

export function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason;
}

// The losing operation remains guarded by the same signal before publishing data.
export function abortable(promise, signal) {
  checkSignal(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function delay(ms, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

// One owner for retries; Socket.IO's own reconnect and write retry stay disabled.
export class Reconnector {
  #options; #recover; #notify; #task; #controller;
  constructor(options, recover, notify) {
    this.#options = options; this.#recover = recover; this.#notify = notify;
  }
  get running() { return !!this.#task; }
  cancel(code = 'OFFLINE') { this.#controller?.abort(new UldaError(code)); }
  run({ automatic = false } = {}) {
    if (this.#task) return this.#task;
    if (automatic && !this.#options.automatic) return Promise.resolve();
    const controller = new AbortController(), { signal } = controller;
    this.#controller = controller;
    // Defer callbacks until #task is assigned, including reentrant reconnect().
    const timer = setTimeout(() => controller.abort(new UldaError('TIMEOUT')), this.#options.budget);
    let completedAttempt;
    const work = Promise.resolve().then(async () => {
      const o = this.#options;
      let last = new UldaError('OFFLINE');
      for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
        checkSignal(signal);
        if (automatic || attempt > 1) {
          const cap = Math.min(o.maxDelay, o.initialDelay * 2 ** (attempt - 1));
          const delayMs = Math.max(1, Math.round(cap * (1 - o.jitter + Math.random() * o.jitter)));
          this.#notify({ phase: 'waiting', attempt, delayMs });
          await delay(delayMs, signal);
        }
        this.#notify({ phase: 'attempt', attempt });
        checkSignal(signal);
        try {
          const result = await abortable(this.#recover(signal), signal);
          checkSignal(signal);
          completedAttempt = attempt;
          return result;
        } catch (error) {
          last = safeError(error);
          checkSignal(signal);
          if (!['OFFLINE', 'TIMEOUT', 'BUSY'].includes(last.code)) throw last;
        }
      }
      throw last;
    });
    const release = () => {
      clearTimeout(timer);
      this.#task = undefined;
      this.#controller = undefined;
    };
    this.#task = work.then(result => {
      // Terminal observers may start a genuinely new cycle (or disconnect).
      release();
      this.#notify({ phase: 'restored', attempt: completedAttempt });
      return result;
    }, error => {
      const clean = safeError(error);
      release();
      this.#notify({ phase: signal.aborted && clean.code !== 'TIMEOUT' ? 'cancelled' : 'stopped', code: clean.code });
      throw clean;
    });
    return this.#task;
  }
}
