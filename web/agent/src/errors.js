export const CODES = [
  'bad_request',
  'not_found',
  'conflict',
  'unauthorized',
  'upstream_unavailable',
  'timeout',
  'internal',
  'unsupported',
];

export class RpcError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'RpcError';
    this.code = CODES.includes(code) ? code : 'internal';
    this.detail = detail;
  }

  toWire() {
    const out = { code: this.code, message: this.message };
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }
}

export function toWireError(err) {
  if (err instanceof RpcError) return err.toWire();
  return { code: 'internal', message: String(err && err.message ? err.message : err) };
}
