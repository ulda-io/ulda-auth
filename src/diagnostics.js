import { check } from './errors.js';
import { exact, id, LIMITS } from './values.js';

// Diagnostic records contain only identifiers, fixed step codes and counts.
export const CLIENT_STEPS = new Set([
  'master.key.derive', 'master.key.ready', 'master.origin.new', 'master.sealed', 'master.local.accepted',
  'master.read', 'master.header', 'master.decrypt', 'master.opened', 'master.catalog',
  'content.read', 'content.key', 'content.decrypt', 'content.opened', 'content.staged',
  'session.memory', 'write.queued', 'write.prepare', 'chain.advance', 'write.sealed',
  'content.memory', 'content.new', 'content.empty.sealed', 'content.id', 'catalog.link',
  'add.commit', 'add.memory', 'content.subscribed', 'changed.receive', 'chain.checked', 'snapshot.checked',
  'changed.memory', 'refresh.begin', 'refresh.memory', 'delete.begin', 'catalog.unlink',
  'delete.proof', 'delete.commit', 'delete.memory', 'superdelete.begin', 'superdelete.commit',
  'session.clear', 'session.closed', 'resync.required',
  'reconnect.waiting', 'reconnect.attempt', 'reconnect.restored', 'reconnect.stopped', 'reconnect.cancelled',
  'repair.begin', 'repair.checked', 'repair.reserve', 'repair.commit', 'repair.memory', 'repair.resolved',
]);
export const SERVER_STEPS = new Set([
  'request.validated', 'hello.ready', 'read.lookup', 'read.found', 'read.subscribed',
  'create.validated', 'create.committed', 'create.subscribed', 'write.lookup', 'write.verified', 'write.committed', 'write.subscribed',
  'reply.ok', 'reply.error', 'changed.sent', 'session.unsubscribed',
]);
export function stepRecord(steps, step, resourceIds = [], count = 0) {
  check(steps.has(step), 'INVALID_PACKET');
  check(Array.isArray(resourceIds) && resourceIds.length <= LIMITS.batch, 'INVALID_PACKET');
  check(Number.isSafeInteger(count) && count >= 0 && (steps === CLIENT_STEPS || count <= LIMITS.batch), 'INVALID_PACKET');
  return Object.freeze({ step, ids: Object.freeze(resourceIds.map(id)), count });
}
export function serverDiagnostic(raw) {
  exact(raw, ['step', 'ids', 'count', 'action']);
  check(['hello', 'read', 'create', 'update', 'delete', 'session.close', 'changed'].includes(raw.action), 'INVALID_PACKET');
  return Object.freeze({ ...stepRecord(SERVER_STEPS, raw.step, raw.ids, raw.count), event: `ulda:${raw.action}` });
}
