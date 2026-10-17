import { check } from './errors.js';
import { LIMITS, binary, exact, id, equal } from './values.js';

export function needsTransfer(items) {
  return items.length > LIMITS.batch || items.some(x => (x.payload?.byteLength ?? 0) > LIMITS.payloadBytes)
    || items.reduce((n, x) => n + x.witness.byteLength + (x.payload?.byteLength ?? 0), 0) > LIMITS.messageBytes;
}

// Only ciphertext/proofs from SDK packet handles enter this generator.
export function* fragments(items) {
  let group = [], bytes = 0;
  for (const item of items) {
    const size = item.witness.byteLength + (item.payload?.byteLength ?? 0);
    if (group.length && (group.length === LIMITS.batch || bytes + size > LIMITS.messageBytes || size > LIMITS.payloadBytes)) {
      yield { kind: 'append', items: group }; group = []; bytes = 0;
    }
    if ((item.payload?.byteLength ?? 0) > LIMITS.payloadBytes) {
      for (let offset = 0; offset < item.payload.length; offset += LIMITS.jsonBytes) {
        yield { kind: 'part', ...(item.id === undefined ? {} : { resourceId: item.id }),
          witness: item.witness, total: item.payload.length, offset,
          payload: item.payload.subarray(offset, offset + LIMITS.jsonBytes) };
      }
    } else { group.push(item); bytes += size; }
  }
  if (group.length) yield { kind: 'append', items: group };
}

export class ChangeAssembly {
  #items = [];
  #partial;
  #bytes;
  constructor(count) {
    check(Number.isSafeInteger(count) && count > 0 && count * 256 <= LIMITS.transferBytes, 'LIMIT');
    this.count = count; this.#bytes = count * 256;
  }
  accept(frame) {
    check(this.#items.length < this.count, 'INVALID_PACKET');
    if (frame.kind === 'append') {
      exact(frame, ['kind', 'items']);
      check(!this.#partial && Array.isArray(frame.items) && frame.items.length > 0 && frame.items.length <= LIMITS.batch, 'INVALID_PACKET');
      check(this.#items.length + frame.items.length <= this.count, 'INVALID_PACKET');
      const prepared = frame.items.map(item => {
        const payload = Object.hasOwn(item, 'payload');
        exact(item, payload ? ['id', 'witness', 'payload'] : ['id']);
        const witness = payload ? binary(item.witness, 167) : undefined;
        const content = payload ? binary(item.payload) : undefined;
        return { id: id(item.id), ...(payload ? { witness, payload: content } : {}) };
      });
      const bytes = prepared.reduce((n, x) => n + (x.witness?.length ?? 0) + (x.payload?.length ?? 0), 0);
      check(bytes <= LIMITS.messageBytes && this.#bytes + bytes <= LIMITS.transferBytes, 'LIMIT');
      this.#bytes += bytes;
      for (const item of prepared) this.#items.push({ ...item, ...(item.payload ? { witness: item.witness.slice(), payload: item.payload.slice() } : {}) });
    } else {
      exact(frame, ['kind', 'resourceId', 'witness', 'total', 'offset', 'payload']);
      check(frame.kind === 'part', 'INVALID_PACKET');
      id(frame.resourceId);
      const witness = binary(frame.witness, 167), payload = binary(frame.payload, LIMITS.jsonBytes);
      check(Number.isSafeInteger(frame.total) && frame.total > 0 && frame.total <= LIMITS.resourceBytes, 'LIMIT');
      check(Number.isSafeInteger(frame.offset) && frame.offset >= 0 && frame.offset + payload.length <= frame.total, 'INVALID_PACKET');
      if (!this.#partial) {
        check(frame.offset === 0 && this.#bytes + frame.total + witness.length <= LIMITS.transferBytes, 'LIMIT');
        this.#bytes += frame.total + witness.length;
        this.#partial = { id: frame.resourceId, witness: witness.slice(), payload: new Uint8Array(frame.total), offset: 0 };
      }
      const item = this.#partial;
      check(item.id === frame.resourceId && item.offset === frame.offset && item.payload.length === frame.total && equal(item.witness, witness), 'INVALID_PACKET');
      item.payload.set(payload, item.offset); item.offset += payload.length;
      if (item.offset === item.payload.length) {
        this.#items.push({ id: item.id, witness: item.witness, payload: item.payload }); this.#partial = undefined;
      }
    }
  }
  finish() {
    check(!this.#partial && this.#items.length === this.count, 'INVALID_PACKET');
    const updated = [], deleted = [];
    for (const item of this.#items) item.payload === undefined ? deleted.push(item.id) : updated.push(item);
    this.#items = [];
    return { updated, deleted };
  }
}
