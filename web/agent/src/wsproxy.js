import WebSocket from 'ws';
import { config, webWsOrigin } from './config.js';
import { KIND_WS_DATA, WS_TEXT, WS_BINARY, encodeFrame } from './frames.js';
import { login } from './zellijweb.js';
import { toWireError } from './errors.js';
import { sendableCloseCode, clampCloseReason } from './wsclose.js';
import { log } from './log.js';
import { listSessionNames, terminalSocketSession } from './sessions.js';
import { convertViewerLease, removeViewer } from './viewers.js';

const STRIP = new Set([
  'cookie', 'authorization', 'host', 'connection', 'upgrade', 'keep-alive',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  'sec-websocket-protocol', 'proxy-authorization', 'proxy-connection',
]);

export class WsProxy {
  constructor(link) {
    this.link = link;
    this.open = new Map();
  }

  async onOpen(msg) {
    const id = msg.id >>> 0;
    if (this.open.has(id)) {
      this.link.sendJson({ t: 'ws.err', id, error: { code: 'conflict', message: 'channel id is already open' } });
      return;
    }
    const entry = { id, socket: null, closed: false, queue: [], viewer: null };
    this.open.set(id, entry);

    let cookie;
    try {
      cookie = await login();
    } catch (err) {
      this.open.delete(id);
      this.link.sendJson({ t: 'ws.err', id, error: toWireError(err) });
      return;
    }
    if (entry.closed) {
      this.open.delete(id);
      return;
    }

    // zellij web creates a new default session for a terminal socket that names no existing
    // session. A browser frame reconnecting after its session was deleted would do exactly
    // that and take the deleted name. Sessions are created only through sessions.create.
    const target = terminalSocketSession(msg.path);
    if (target !== null) {
      let known;
      try {
        known = target ? (await listSessionNames()).has(target) : false;
      } catch (err) {
        this.open.delete(id);
        this.link.sendJson({ t: 'ws.err', id, error: toWireError(err) });
        return;
      }
      if (!known) {
        this.open.delete(id);
        log.info('refused a terminal socket for a session that does not exist', { id, session: target });
        this.link.sendJson({ t: 'ws.err', id, error: { code: 'not_found', message: `session ${target || '(unnamed)'} does not exist` } });
        return;
      }
      if (entry.closed) {
        this.open.delete(id);
        return;
      }
      if (target) {
        entry.viewer = target;
        convertViewerLease(target);
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(msg.headers || {})) {
      if (STRIP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers.Cookie = cookie;
    headers.Host = `${config.webHost}:${config.webPort}`;

    const url = `${webWsOrigin}${msg.path || '/'}`;
    const socket = new WebSocket(url, msg.protocols && msg.protocols.length ? msg.protocols : undefined, {
      headers,
      origin: webWsOrigin,
      maxPayload: 4 * 1024 * 1024,
    });
    entry.socket = socket;

    socket.on('open', () => {
      this.link.sendJson({ t: 'ws.opened', id, protocol: socket.protocol || null });
      for (const q of entry.queue) this.#write(entry, q.payload, q.flags);
      entry.queue = [];
    });

    socket.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.link.sendBinary(encodeFrame(KIND_WS_DATA, id, isBinary ? WS_BINARY : WS_TEXT, buf));
    });

    socket.on('error', (err) => {
      log.warn('ws proxy upstream error', { id, path: msg.path, error: String(err.message) });
      if (socket.readyState === WebSocket.CONNECTING) {
        this.link.sendJson({
          t: 'ws.err',
          id,
          error: { code: 'upstream_unavailable', message: `${err.code || 'error'}: ${err.message}` },
        });
        this.open.delete(id);
        removeViewer(entry.viewer);
      }
    });

    socket.on('close', (code, reason) => {
      if (!this.open.has(id)) return;
      this.open.delete(id);
      removeViewer(entry.viewer);
      this.link.sendJson({ t: 'ws.close', id, code: code || 1000, reason: reason ? reason.toString() : '' });
    });
  }

  onData(id, flags, payload) {
    const entry = this.open.get(id >>> 0);
    if (!entry) return;
    if (!entry.socket || entry.socket.readyState === 0) {
      entry.queue.push({ payload: Buffer.from(payload), flags });
      return;
    }
    this.#write(entry, payload, flags);
  }

  onClose(msg) {
    const entry = this.open.get(msg.id >>> 0);
    if (!entry) return;
    entry.closed = true;
    this.open.delete(entry.id);
    removeViewer(entry.viewer);
    if (entry.socket) {
      try {
        entry.socket.close(sendableCloseCode(msg.code, 1000), clampCloseReason(msg.reason));
      } catch (err) {
        log.warn('closing the upstream socket threw', { id: entry.id, error: String(err?.message || err) });
        entry.socket.terminate();
      }
    }
  }

  closeAll() {
    for (const entry of this.open.values()) {
      entry.closed = true;
      removeViewer(entry.viewer);
      if (entry.socket) {
        try { entry.socket.close(1001, 'tunnel down'); } catch { entry.socket.terminate(); }
      }
    }
    this.open.clear();
  }

  #write(entry, payload, flags) {
    if (!entry.socket || entry.socket.readyState !== WebSocket.OPEN) return;
    entry.socket.send(Buffer.from(payload), { binary: (flags & WS_TEXT) === 0 });
  }
}
