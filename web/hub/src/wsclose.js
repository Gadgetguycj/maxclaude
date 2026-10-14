// ws throws instead of returning an error when close() is handed a status code it will not put
// on the wire, or a reason over 123 bytes. Peer supplied values go through here first.
// Valid: 1000-1003, 1007-1014, 3000-4999. Reserved and never sendable: 1004, 1005, 1006, 1015.
const MAX_REASON_BYTES = 123;

export function sendableCloseCode(code, fallback = 1011) {
  const ok =
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999));
  return ok ? code : fallback;
}

export function clampCloseReason(value) {
  if (value === undefined || value === null) return '';
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  let out = text.slice(0, MAX_REASON_BYTES);
  while (out.length && Buffer.byteLength(out) > MAX_REASON_BYTES) out = out.slice(0, -1);
  return out;
}
