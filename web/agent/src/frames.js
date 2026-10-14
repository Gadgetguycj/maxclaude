export const KIND_WS_DATA = 0x01;
export const KIND_HTTP_BODY = 0x02;
export const KIND_FILE_UPLOAD = 0x03;
export const KIND_FILE_DOWNLOAD = 0x04;

export const WS_TEXT = 0x01;
export const WS_BINARY = 0x02;
export const BODY_FINAL = 0x01;
export const FILE_FINAL = 0x01;

const HEADER = 6;

export function encodeFrame(kind, id, flags, payload) {
  const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(HEADER + body.length);
  buf.writeUInt8(kind, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  buf.writeUInt8(flags, 5);
  body.copy(buf, HEADER);
  return buf;
}

export function decodeFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < HEADER) return null;
  return {
    kind: buf.readUInt8(0),
    id: buf.readUInt32BE(1),
    flags: buf.readUInt8(5),
    payload: buf.subarray(HEADER),
  };
}
