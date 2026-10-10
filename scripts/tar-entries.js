import { gunzipSync } from 'node:zlib';
export const ARCHIVE_BYTES = 64 * 1024 * 1024;
const invalid = () => { throw new Error('Unsupported or invalid archive.'); };
const string = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0.*$/s, '');
function octal(bytes) {
  const value = string(bytes).trim();
  if (!/^[0-7]+$/.test(value)) invalid();
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) invalid();
  return result;
}
// Inspection only. Unsupported gzip/PAX/GNU metadata must fail closed, not be
// silently skipped. No extraction and no use of archive paths as filesystem paths.
export function inspectTar(compressed, { maxOutputLength = ARCHIVE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 1 || maxOutputLength > ARCHIVE_BYTES) invalid();
  const raw = gunzipSync(compressed, { maxOutputLength });
  if (raw.length < 1024 || raw.length % 512 !== 0) invalid();
  const entries = [], headers = [], paths = new Set();
  for (let offset = 0; offset + 1024 <= raw.length;) {
    const head = raw.subarray(offset, offset + 512);
    if (head.every(byte => byte === 0)) {
      // Two terminator blocks and only zero padding after them.
      if (!raw.subarray(offset).every(byte => byte === 0)) invalid();
      return { entries, headers, expandedBytes: raw.length };
    }
    const checksum = octal(head.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : head[i];
    if (sum !== checksum || !['ustar\0', 'ustar '].includes(head.subarray(257, 263).toString('ascii'))) invalid();
    const size = octal(head.subarray(124, 136));
    const end = offset + 512 + size, next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next + 1024 > raw.length || !raw.subarray(end, next).every(byte => byte === 0)) invalid();
    const prefix = string(head.subarray(345, 500));
    const path = (prefix ? prefix + '/' : '') + string(head.subarray(0, 100));
    if (!path || paths.has(path)) invalid();
    paths.add(path);
    const type = head[156];
    if (type === 0 || type === 48) entries.push({ path, bytes: raw.subarray(offset + 512, end) });
    else if (type !== 53 || size !== 0) invalid();
    // Scan all supported header metadata too, including directory headers.
    headers.push(head);
    offset = next;
  }
  invalid();
}
export const tarEntries = compressed => inspectTar(compressed).entries;
