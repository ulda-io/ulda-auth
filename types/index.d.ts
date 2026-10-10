/** ULDA Auth client SDK. JSON only; runtime validation is authoritative. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ResourceId = string;
export type Mode = 'X' | 'S';
export type Status = 'connecting' | 'ready' | 'open' | 'disconnected' | 'reconnecting' | 'needsResync' | 'closed';
export type ErrorCode = 'INVALID_INPUT' | 'INVALID_PACKET' | 'UNSUPPORTED_PROFILE' | 'CRYPTO_FAILED' |
  'CLOSED' | 'OFFLINE' | 'NOT_OPEN' | 'UNKNOWN_OUTCOME' | 'CONFLICT' | 'NOT_FOUND' | 'EXISTS' |
  'NEEDS_RESYNC' | 'ROLLBACK' | 'LIMIT' | 'UNSUPPORTED' | 'SERVER_ERROR' | 'STALE_REFERENCE' | 'BUSY' | 'TIMEOUT';
export class UldaError extends Error { constructor(code: string); readonly code: ErrorCode; }
export interface Ok { ok: true }
export interface AddResult extends Ok { name: string; subscriptionReady: boolean }
export interface RecoveryResult extends Ok { previousId: ResourceId; id: ResourceId; sourceAge: number; reconciled: boolean }
export interface ReconnectOptions { maxAttempts?: number; initialDelay?: number; maxDelay?: number; jitter?: number; budget?: number }
export interface TransportOptions { timeout?: number; allowInsecureLocalhost?: boolean; diagnostics?: boolean }
export interface UldaOptions extends Omit<TransportOptions, 'diagnostics'> { reconnect?: false | ReconnectOptions; transport?: SocketIoTransport }
export interface ClientTrace { readonly time: number; readonly phase: 'client'; readonly event: string; readonly step: string; readonly ids: readonly ResourceId[]; readonly count: number }
export type ChangeEvent = { kind: 'updated'; id: ResourceId } | { kind: 'updated' | 'deleted' | 'recovered'; ids: ResourceId[] };
export interface ReconnectEvent { readonly phase: 'waiting' | 'attempt' | 'restored' | 'stopped' | 'cancelled'; readonly attempt?: number; readonly delayMs?: number; readonly code?: ErrorCode }
export interface UldaEvents { change: ChangeEvent; status: Status; error: UldaError; trace: ClientTrace; reconnect: ReconnectEvent }
type Reserved = 'get' | 'update' | 'delete' | 'field' | 'toJSON' | 'then';
export type Reference<T extends JsonValue = JsonValue> = {
  get(): T;
  toJSON(): T;
  update(value: T): Promise<Ok>;
  delete(): Promise<Ok>;
  field(key: string | number): Reference;
} & (JsonValue extends T ? { readonly [key: string]: Reference } :
  T extends JsonValue[] ? { readonly [index: number]: Reference<T[number]> } :
  T extends object ? { readonly [K in Exclude<keyof T, Reserved>]: T[K] extends JsonValue ? Reference<T[K]> : never } : {});
export type DataTree<T extends Record<string, JsonValue> = Record<string, JsonValue>> = {
  readonly [K in Exclude<keyof T, 'field' | 'toJSON' | 'then'>]: Reference<T[K]>
} & { field<K extends keyof T & string>(name: K): Reference<T[K]>; toJSON(): T };
export class Ulda<T extends Record<string, JsonValue> = Record<string, JsonValue>> {
  constructor(endpoint: string, options?: UldaOptions);
  readonly ready: Promise<void>;
  readonly status: Status;
  /** Used by SDK references; applications should not use this as a server revision. */
  readonly contextGeneration: number;
  readonly data: DataTree<T>;
  on<K extends keyof UldaEvents>(event: K, listener: (value: UldaEvents[K]) => void): () => boolean;
  register(password: string): Promise<ResourceId>;
  connect(id: ResourceId, password: string): Promise<DataTree<T>>;
  add<K extends keyof T & string>(name: K, value: T[K], mode?: Mode): Promise<AddResult>;
  update<K extends keyof T & string>(name: K, value: T[K]): Promise<Ok>;
  set(name: keyof T & string, path: (string | number)[], value: JsonValue): Promise<Ok>;
  remove(name: keyof T & string, path: (string | number)[]): Promise<Ok>;
  delete(name: keyof T & string): Promise<Ok>;
  superDelete(): Promise<Ok>;
  recoverContent(name: keyof T & string): Promise<RecoveryResult>;
  snapshot(): T;
  value<K extends keyof T & string>(name: K): T[K];
  value(name: keyof T & string, path: (string | number)[]): JsonValue;
  ref<K extends keyof T & string>(name: K): Reference<T[K]>;
  refresh(): Promise<DataTree<T>>;
  reconnect(): Promise<DataTree<T> | undefined>;
  close(): Promise<void>;
}
/** Ciphertext-only records at the transport boundary. */
export interface EncryptedResource { readonly id: ResourceId; readonly witness: Uint8Array; readonly payload: Uint8Array }
export interface ChangedEvent { readonly updated: readonly EncryptedResource[]; readonly deleted: readonly ResourceId[] }
export interface ResourceSummary { readonly id?: ResourceId; readonly witnessBytes: number; readonly payloadBytes?: number }
export interface TransportTrace {
  readonly time: number; readonly phase: 'send' | 'ack' | 'failure' | 'push' | 'connection' | 'server';
  readonly event: string; readonly request?: number; readonly durationMs?: number; readonly code?: ErrorCode;
  readonly ok?: true; readonly volatile?: boolean; readonly ids?: readonly ResourceId[];
  readonly items?: readonly ResourceSummary[]; readonly updated?: readonly ResourceSummary[];
  readonly deleted?: readonly ResourceId[]; readonly step?: string; readonly count?: number;
}
export interface TransportEvents { changed: ChangedEvent; disconnect: { intentional: boolean }; error: UldaError; trace: TransportTrace }
declare const packetBrand: unique symbol;
/** SDK-created handle, not a user-supplied wire object; no public packet constructor. */
export interface PacketHandle { readonly [packetBrand]: true }
export class SocketIoTransport {
  constructor(endpoint: string, options?: TransportOptions);
  readonly connected: boolean;
  on<K extends keyof TransportEvents>(event: K, listener: (value: TransportEvents[K]) => void): () => boolean;
  start(options?: { signal?: AbortSignal }): Promise<void>;
  send(packet: PacketHandle, options?: { volatile?: boolean; signal?: AbortSignal }): Promise<unknown>;
  disconnect(): void;
  close(): void;
}
