import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config } from './config.js';
import { sendableCloseCode, clampCloseReason } from './wsclose.js';

export const PROTOCOL_VERSION = 1;
export const SERVER_ID = 'maxclaude-web/1.4.0';

const MAX_MESSAGE = 4 * 1024 * 1024;
const BODY_CHUNK = 512 * 1024;
const HANDSHAKE_MS = 10000;
const STALE_MS = 60000;

const KIND_WS_DATA = 0x01;
const KIND_HTTP_BODY = 0x02;
const KIND_FILE_UPLOAD = 0x03;
const KIND_FILE_DOWNLOAD = 0x04;

const WS_FLAG_TEXT = 0x01;
const WS_FLAG_BINARY = 0x02;
const HTTP_FLAG_FINAL = 0x01;
const FILE_FLAG_FINAL = 0x01;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const HOP_BY_HOP_REQUEST = new Set([
  'cookie',
  'authorization',
  'host',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'content-length',
  'upgrade-insecure-requests'
]);

const STRIP_RESPONSE = new Set(['set-cookie', 'transfer-encoding', 'connection', 'keep-alive']);

function frame(kind, id, flags, payload) {
  const head = Buffer.allocUnsafe(6);
  head[0] = kind;
  head.writeUInt32BE(id >>> 0, 1);
  head[5] = flags;
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
}

function normalizeSessionStatus(data) {
  const sessions = data?.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return {};
  const out = {};
  for (const [name, value] of Object.entries(sessions)) {
    if (typeof name !== 'string' || !name) continue;
    if (!value || !['busy', 'idle', 'absent', 'unknown'].includes(value.state)) continue;
    out[name] = {
      state: value.state,
      updatedAt: Number(value.updatedAt) || Date.now(),
      lastResponseAt: Math.max(0, Number(value.lastResponseAt) || 0)
    };
  }
  return out;
}

export class Tunnel extends EventEmitter {
  constructor(secret) {
    super();
    this.secret = Buffer.from(secret, 'utf8');
    this.link = null;
    this.connId = null;
    this.connectedAt = null;
    this.lastInbound = 0;
    this.info = null;
    this.degraded = null;
    this.sessionStatus = {};
    this.pending = new Map();
    this.httpChannels = new Map();
    this.wsChannels = new Map();
    this.fileChannels = new Map();
    this.rpcSeq = 0;
    this.pingSeq = 0;
    this.httpSeq = 0;
    this.wsSeq = 0;
    this.fileSeq = 0;
    this.pingTimer = setInterval(() => this.tick(), config.agentPingMs);
    this.pingTimer.unref?.();
  }

  get connected() {
    return Boolean(this.link) && this.link.readyState === WebSocket.OPEN;
  }

  status() {
    return {
      connected: this.connected,
      since: this.connected ? this.connectedAt : null,
      info: this.connected ? this.info : null,
      degraded: this.connected ? this.degraded : null,
      sessionStatus: this.connected ? this.sessionStatus : {}
    };
  }

  tick() {
    if (!this.connected) return;
    if (Date.now() - this.lastInbound > STALE_MS) {
      this.log('no inbound traffic for 60s, dropping the link');
      this.link.close(4400, 'stale');
      return;
    }
    this.pingSeq += 1;
    this.sendJson({ t: 'ping', id: `p-${this.pingSeq}` });
  }

  log(message, extra) {
    const line = { at: new Date().toISOString(), scope: 'tunnel', message };
    if (extra) line.detail = extra;
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  sendJson(obj) {
    if (!this.link || this.link.readyState !== WebSocket.OPEN) return false;
    this.link.send(JSON.stringify(obj));
    return true;
  }

  sendBinary(buf) {
    if (!this.link || this.link.readyState !== WebSocket.OPEN) return false;
    this.link.send(buf, { binary: true });
    return true;
  }

  nextChannel(which) {
    const key = which === 'http' ? 'httpSeq' : which === 'ws' ? 'wsSeq' : 'fileSeq';
    this[key] = this[key] >= 0xffffffff ? 1 : this[key] + 1;
    return this[key];
  }

  // Handshake is section 4 of PROTOCOL.md. Nothing but auth is accepted before auth.ok.
  accept(ws, remote) {
    const nonce = crypto.randomBytes(32).toString('hex');
    let authed = false;

    const timer = setTimeout(() => {
      if (!authed) {
        this.log('handshake timeout', { remote });
        ws.close(4408, 'handshake timeout');
      }
    }, HANDSHAKE_MS);

    const fail = (code, error, closeCode) => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ t: 'auth.err', error: { code, message: error } }));
      this.log('agent rejected', { remote, code, error });
      ws.close(closeCode, code);
    };

    ws.on('message', (data, isBinary) => {
      if (!authed) {
        if (isBinary) return fail('bad_request', 'binary frame before auth', 4400);
        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return fail('bad_request', 'malformed json', 4400);
        }
        if (msg.t !== 'auth') return fail('bad_request', 'expected auth', 4400);
        if (msg.v !== PROTOCOL_VERSION) return fail('unsupported', `protocol v${msg.v}`, 4400);

        const expected = crypto.createHmac('sha256', this.secret).update(nonce, 'ascii').digest('hex');
        const given = typeof msg.proof === 'string' ? msg.proof.toLowerCase() : '';
        const ok =
          given.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
        if (!ok) return fail('unauthorized', 'bad proof', 4401);

        if (this.connected) {
          clearTimeout(timer);
          this.log('second agent refused', { remote });
          ws.close(4409, 'another agent is already connected');
          return;
        }

        authed = true;
        clearTimeout(timer);
        this.adopt(ws, msg, remote);
        return;
      }
      this.onMessage(data, isBinary);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      if (this.link === ws) this.release(code, reason.toString());
    });

    ws.on('error', (err) => {
      this.log('link error', { message: err.message });
    });

    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, nonce, server: SERVER_ID }));
  }

  adopt(ws, authMsg, remote) {
    this.link = ws;
    this.connId = `c-${crypto.randomBytes(2).toString('hex')}`;
    this.connectedAt = Date.now();
    this.lastInbound = Date.now();
    this.info = null;
    this.degraded = null;
    this.sessionStatus = {};
    this.sendJson({ t: 'auth.ok', conn: this.connId, serverTime: Math.floor(Date.now() / 1000) });
    this.log('agent connected', {
      remote,
      agent: authMsg.agent,
      agentVersion: authMsg.agentVersion,
      conn: this.connId
    });
    this.emit('connected');
  }

  release(code, reason) {
    this.log('agent disconnected', { code, reason });
    this.link = null;
    this.connId = null;
    this.connectedAt = null;
    this.info = null;
    this.degraded = null;
    this.sessionStatus = {};

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new TunnelError('agent_disconnected', 'the agent link dropped while the request was in flight'));
    }
    this.pending.clear();

    for (const [, channel] of this.httpChannels) channel.onError('agent_disconnected', 'the agent link dropped');
    this.httpChannels.clear();

    for (const [, channel] of this.wsChannels) channel.onClose(1011, 'agent link dropped');
    this.wsChannels.clear();

    for (const [, channel] of this.fileChannels) channel.onError('agent_disconnected', 'the agent link dropped');
    this.fileChannels.clear();

    this.emit('disconnected');
  }

  onMessage(data, isBinary) {
    this.lastInbound = Date.now();
    if (isBinary) return this.onBinary(data);

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.link?.close(4400, 'malformed json');
      return;
    }

    switch (msg.t) {
      case 'pong':
        return;
      case 'ping':
        this.sendJson({ t: 'pong', id: msg.id });
        return;
      case 'res': {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(TunnelError.fromWire(msg.error));
        return;
      }
      case 'event': {
        if (msg.event === 'agent.ready') {
          this.info = msg.data || null;
          this.degraded = null;
          this.log('agent ready', { host: msg.data?.host, webSharing: msg.data?.webSharing });
        } else if (msg.event === 'agent.degraded') {
          this.degraded = msg.data || { reason: 'unknown' };
          this.log('agent degraded', this.degraded);
        } else if (msg.event === 'sessions.status') {
          this.sessionStatus = normalizeSessionStatus(msg.data);
        }
        this.emit('event', msg);
        return;
      }
      case 'http.res': {
        this.httpChannels.get(msg.id)?.onResponse(msg);
        return;
      }
      case 'http.err': {
        const channel = this.httpChannels.get(msg.id);
        if (channel) channel.onError(msg.error?.code || 'upstream_unavailable', msg.error?.message || '');
        return;
      }
      case 'ws.opened': {
        this.wsChannels.get(msg.id)?.onOpened(msg.protocol || null);
        return;
      }
      case 'ws.err': {
        const channel = this.wsChannels.get(msg.id);
        if (channel) channel.onError(msg.error?.code || 'upstream_unavailable', msg.error?.message || '');
        return;
      }
      case 'ws.close': {
        this.wsChannels.get(msg.id)?.onClose(msg.code || 1000, msg.reason || '');
        return;
      }
      case 'file.upload.ready':
      case 'file.upload.ack':
      case 'file.upload.done':
      case 'file.download.ready':
      case 'file.download.done': {
        this.fileChannels.get(msg.id)?.onMessage(msg);
        return;
      }
      case 'file.upload.error':
      case 'file.download.error': {
        this.fileChannels.get(msg.id)?.onError(
          msg.error?.code || 'internal', msg.error?.message || 'file transfer failed', msg.error?.detail
        );
        return;
      }
      default:
        return;
    }
  }

  onBinary(buf) {
    if (buf.length < 6) return;
    const kind = buf[0];
    const id = buf.readUInt32BE(1);
    const flags = buf[5];
    const payload = buf.subarray(6);

    if (kind === KIND_HTTP_BODY) {
      this.httpChannels.get(id)?.onBody(payload, (flags & HTTP_FLAG_FINAL) !== 0);
      return;
    }
    if (kind === KIND_WS_DATA) {
      this.wsChannels.get(id)?.onData(payload, (flags & WS_FLAG_BINARY) !== 0);
      return;
    }
    if (kind === KIND_FILE_DOWNLOAD) {
      this.fileChannels.get(id)?.onData(payload, (flags & FILE_FLAG_FINAL) !== 0);
    }
  }

  rpc(method, params = {}, timeoutMs = config.agentRpcTimeoutMs) {
    if (!this.connected) {
      return Promise.reject(new TunnelError('agent_disconnected', 'the agent is not connected'));
    }
    this.rpcSeq += 1;
    const id = `r-${this.rpcSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TunnelError('timeout', `the agent did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendJson({ t: 'req', id, method, params });
    });
  }

  proxyHttp(req, res, path) {
    if (!this.connected) {
      res.status(503).json({ error: 'agent_disconnected', message: 'the agent is not connected' });
      return;
    }

    const id = this.nextChannel('http');
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_REQUEST.has(key.toLowerCase())) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let settled = false;

    const channel = {
      onResponse: (msg) => {
        settled = true;
        for (const [key, value] of Object.entries(msg.headers || {})) {
          if (STRIP_RESPONSE.has(key.toLowerCase())) continue;
          res.setHeader(key, value);
        }
        res.status(msg.status || 200);
      },
      onBody: (payload, final) => {
        if (payload.length) res.write(payload);
        if (final) {
          this.httpChannels.delete(id);
          res.end();
        }
      },
      onError: (code, message) => {
        this.httpChannels.delete(id);
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        res.status(code === 'agent_disconnected' ? 503 : 502).json({ error: code, message });
      }
    };

    this.httpChannels.set(id, channel);
    this.sendJson({ t: 'http.req', id, method: req.method, path, headers, hasBody });

    res.on('close', () => {
      if (this.httpChannels.delete(id)) this.sendJson({ t: 'http.cancel', id });
    });

    if (!hasBody) return;

    req.on('data', (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += BODY_CHUNK) {
        this.sendBinary(frame(KIND_HTTP_BODY, id, 0, chunk.subarray(offset, offset + BODY_CHUNK)));
      }
    });
    req.on('end', () => this.sendBinary(frame(KIND_HTTP_BODY, id, HTTP_FLAG_FINAL, Buffer.alloc(0))));
    req.on('error', () => {
      if (this.httpChannels.delete(id)) this.sendJson({ t: 'http.cancel', id });
    });
  }

  proxyWebSocket(clientWs, path) {
    if (!this.connected) {
      clientWs.close(1013, 'agent disconnected');
      return;
    }

    const id = this.nextChannel('ws');
    const queue = [];
    let opened = false;
    let closed = false;

    const teardown = (code, reason) => {
      if (closed) return;
      closed = true;
      this.wsChannels.delete(id);
      if (clientWs.readyState !== WebSocket.OPEN && clientWs.readyState !== WebSocket.CONNECTING) return;
      const sendable = sendableCloseCode(code, 1011);
      if (sendable !== code) this.log('rewrote an unsendable close code', { id, from: code, to: sendable });
      try {
        clientWs.close(sendable, clampCloseReason(reason));
      } catch (err) {
        this.log('closing the browser socket threw', { id, code: sendable, error: String(err?.message || err) });
        clientWs.terminate();
      }
    };

    const channel = {
      onOpened: () => {
        opened = true;
        for (const item of queue.splice(0)) {
          this.sendBinary(frame(KIND_WS_DATA, id, item.binary ? WS_FLAG_BINARY : WS_FLAG_TEXT, item.payload));
        }
      },
      onData: (payload, binary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(payload, { binary });
      },
      onError: (code, message) => {
        this.log('proxied websocket failed', { id, code, message });
        teardown(1011, message || code);
      },
      onClose: (code, reason) => teardown(code, reason)
    };

    this.wsChannels.set(id, channel);
    this.sendJson({ t: 'ws.open', id, path, protocols: [], headers: {} });

    clientWs.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (payload.length > MAX_MESSAGE - 6) {
        teardown(1009, 'message too large');
        return;
      }
      if (!opened) {
        queue.push({ payload, binary: isBinary });
        return;
      }
      this.sendBinary(frame(KIND_WS_DATA, id, isBinary ? WS_FLAG_BINARY : WS_FLAG_TEXT, payload));
    });

    clientWs.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      this.wsChannels.delete(id);
      this.sendJson({ t: 'ws.close', id, code: sendableCloseCode(code, 1000), reason: clampCloseReason(reason) });
    });

    clientWs.on('error', () => teardown(1011, 'client error'));
  }

  async upload(req, { session, batch, uploadId, path, size, totalSize = size, offset = 0, final = true }) {
    if (!this.connected) throw new TunnelError('agent_disconnected', 'the agent is not connected');
    if (!Number.isInteger(size) || size < 0 || !Number.isInteger(totalSize)
      || totalSize < 0 || totalSize > MAX_UPLOAD_BYTES) {
      throw new TunnelError('bad_request', 'a single upload may not exceed 2 GB');
    }
    const id = this.nextChannel('file');
    const channel = new UploadChannel(this, id);
    this.fileChannels.set(id, channel);
    this.sendJson({ t: 'file.upload.open', id, session, batch, uploadId, path, size, totalSize, offset, final });
    let sent = 0;
    try {
      await channel.ready;
      for await (const chunk of req) {
        for (let offset = 0; offset < chunk.length; offset += BODY_CHUNK) {
          const piece = chunk.subarray(offset, offset + BODY_CHUNK);
          sent += piece.length;
          if (sent > size) {
            throw new TunnelError('bad_request', 'upload exceeded its declared size or the 2 GB limit');
          }
          const ack = channel.waitForAck();
          this.sendBinary(frame(KIND_FILE_UPLOAD, id, 0, piece));
          await ack;
        }
      }
      if (sent !== size) {
        throw new TunnelError('bad_request', 'upload body size did not match its declaration', { declared: size, received: sent });
      }
      const done = channel.waitForDone();
      this.sendBinary(frame(KIND_FILE_UPLOAD, id, FILE_FLAG_FINAL, Buffer.alloc(0)));
      return await done;
    } catch (err) {
      this.sendJson({ t: 'file.upload.cancel', id });
      throw err;
    } finally {
      this.fileChannels.delete(id);
    }
  }

  async download(req, res, { session, path }) {
    if (!this.connected) throw new TunnelError('agent_disconnected', 'the agent is not connected');
    const id = this.nextChannel('file');
    const channel = new DownloadChannel(this, id, req, res);
    this.fileChannels.set(id, channel);
    this.sendJson({ t: 'file.download.open', id, session, path });
    try {
      return await channel.result;
    } finally {
      this.fileChannels.delete(id);
    }
  }
}

class UploadChannel {
  constructor(tunnel, id) {
    this.tunnel = tunnel;
    this.id = id;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.reject = reject; });
    this.ackResolve = null;
    this.doneResolve = null;
  }

  waitForAck() {
    return new Promise((resolve, reject) => { this.ackResolve = resolve; this.ackReject = reject; });
  }

  waitForDone() {
    return new Promise((resolve, reject) => { this.doneResolve = resolve; this.doneReject = reject; });
  }

  onMessage(msg) {
    if (msg.t === 'file.upload.ready') this.readyResolve(msg);
    else if (msg.t === 'file.upload.ack') {
      const resolve = this.ackResolve;
      this.ackResolve = null;
      this.ackReject = null;
      resolve?.(msg);
    } else if (msg.t === 'file.upload.done') this.doneResolve?.(msg);
  }

  onError(code, message, detail) {
    const err = new TunnelError(code, message, detail);
    this.reject?.(err);
    this.ackReject?.(err);
    this.doneReject?.(err);
    this.ackResolve = null;
    this.ackReject = null;
    this.doneResolve = null;
    this.doneReject = null;
  }
}

class DownloadChannel {
  constructor(tunnel, id, req, res) {
    this.tunnel = tunnel;
    this.id = id;
    this.req = req;
    this.res = res;
    this.ready = false;
    this.finished = false;
    this.bytes = 0;
    this.meta = null;
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    req.on('aborted', () => this.cancel());
    res.on('close', () => { if (!this.finished) this.cancel(); });
  }

  onMessage(msg) {
    if (msg.t === 'file.download.ready') {
      this.ready = true;
      this.meta = msg;
      const encoded = encodeURIComponent(msg.name || 'download').replace(/'/g, '%27');
      this.res.status(200);
      this.res.setHeader('Content-Type', msg.type === 'directory' ? 'application/zip' : 'application/octet-stream');
      this.res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
      this.res.setHeader('Cache-Control', 'no-store');
      if (Number.isSafeInteger(msg.size)) this.res.setHeader('Content-Length', String(msg.size));
    } else if (msg.t === 'file.download.done' && !this.finished) {
      this.finish(msg);
    }
  }

  async onData(payload, final) {
    if (this.finished || !this.ready) return;
    try {
      if (payload.length) {
        this.bytes += payload.length;
        if (!this.res.write(payload)) await new Promise((resolve) => this.res.once('drain', resolve));
      }
      this.tunnel.sendJson({ t: 'file.download.ack', id: this.id });
      if (final) {
        this.finished = true;
        this.res.end(() => this.resolve({ path: this.meta?.path, size: this.bytes, type: this.meta?.type }));
      }
    } catch (err) {
      this.onError('internal', err.message);
    }
  }

  finish(msg) {
    if (this.finished) return;
    this.finished = true;
    if (!this.res.writableEnded) this.res.end();
    this.resolve({ path: msg.path || this.meta?.path, size: Number(msg.size) || this.bytes, type: this.meta?.type });
  }

  onError(code, message, detail) {
    if (this.finished) return;
    this.finished = true;
    const err = new TunnelError(code, message, detail);
    if (!this.res.headersSent) this.reject(err);
    else {
      this.res.destroy(err);
      this.reject(err);
    }
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    this.tunnel.sendJson({ t: 'file.download.cancel', id: this.id });
    this.reject(new TunnelError('timeout', 'download cancelled'));
  }
}

export class TunnelError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.code = code;
    this.detail = detail;
  }

  static fromWire(error) {
    if (!error) return new TunnelError('internal', 'the agent returned an empty error');
    return new TunnelError(error.code || 'internal', error.message || '', error.detail);
  }

  get httpStatus() {
    switch (this.code) {
      case 'bad_request':
        return 400;
      case 'not_found':
        return 404;
      case 'conflict':
        return 409;
      case 'timeout':
        return 504;
      case 'agent_disconnected':
      case 'upstream_unavailable':
        return 503;
      case 'unsupported':
        return 501;
      default:
        return 502;
    }
  }
}
