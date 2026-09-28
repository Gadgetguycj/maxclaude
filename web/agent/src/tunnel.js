import crypto from 'node:crypto';
import WebSocket from 'ws';
import { config } from './config.js';
import { log } from './log.js';
import { toWireError } from './errors.js';
import { dispatch, agentInfo } from './methods.js';
import { HttpProxy } from './httpproxy.js';
import { WsProxy } from './wsproxy.js';
import { decodeFrame, KIND_WS_DATA, KIND_HTTP_BODY, KIND_FILE_UPLOAD } from './frames.js';
import { FileTransfers } from './files.js';

const IDLE_MS = 60000;
const PING_MS = 25000;
const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 60000;

export class Tunnel {
  constructor(secret) {
    this.secret = secret;
    this.attempt = 0;
    this.stopped = false;
    this.ws = null;
    this.authed = false;
    this.connectionEpoch = 0;
    this.http = null;
    this.wsp = null;
    this.files = null;
    this.idleTimer = null;
    this.pingTimer = null;
  }

  start() {
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.#teardown(1001, 'agent stopping');
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf, { binary: true });
  }

  sendEvent(event, data) {
    if (this.authed) this.sendJson({ t: 'event', event, data });
  }

  #connect() {
    if (this.stopped) return;
    const ws = new WebSocket(config.hubUrl, {
      handshakeTimeout: 15000,
      maxPayload: 4 * 1024 * 1024,
      headers: { 'user-agent': config.version },
    });
    this.ws = ws;
    this.authed = false;
    this.http = new HttpProxy(this);
    this.wsp = new WsProxy(this);
    this.files = new FileTransfers(this);

    ws.on('open', () => {
      log.info('tunnel socket open, waiting for hello', { url: config.hubUrl });
      this.#resetIdle();
    });

    ws.on('message', (data, isBinary) => {
      this.#resetIdle();
      if (isBinary) this.#onBinary(data);
      else this.#onText(data);
    });

    ws.on('close', (code, reason) => {
      log.warn('tunnel closed', { code, reason: reason ? reason.toString() : '' });
      this.#afterClose();
    });

    ws.on('error', (err) => {
      log.warn('tunnel error', { error: String(err.message) });
    });
  }

  #onText(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log.warn('tunnel sent a malformed text frame');
      this.#teardown(4400, 'malformed json');
      return;
    }

    if (!this.authed && msg.t !== 'hello') {
      if (msg.t === 'auth.err') {
        log.error('tunnel auth rejected', { error: msg.error });
        this.#teardown(4401, 'auth rejected');
        return;
      }
      if (msg.t !== 'auth.ok') {
        this.#teardown(4400, 'message before auth');
        return;
      }
    }

    switch (msg.t) {
      case 'hello':
        this.#sendAuth(msg);
        break;
      case 'auth.ok':
        this.authed = true;
        this.connectionEpoch += 1;
        this.attempt = 0;
        log.info('tunnel authenticated', { conn: msg.conn });
        agentInfo()
          .then((info) => this.sendJson({ t: 'event', event: 'agent.ready', data: info }))
          .catch((err) => log.warn('agent.info failed after auth', { error: String(err.message) }));
        this.#startPing();
        break;
      case 'ping':
        this.sendJson({ t: 'pong', id: msg.id });
        break;
      case 'pong':
        break;
      case 'req':
        this.#onReq(msg);
        break;
      case 'http.req':
        this.http.onReq(msg);
        break;
      case 'http.cancel':
        this.http.onCancel(msg.id);
        break;
      case 'ws.open':
        this.wsp.onOpen(msg);
        break;
      case 'ws.close':
        this.wsp.onClose(msg);
        break;
      case 'file.upload.open':
        this.files.onUploadOpen(msg);
        break;
      case 'file.upload.cancel':
        this.files.onUploadCancel(msg.id);
        break;
      case 'file.download.open':
        this.files.onDownloadOpen(msg);
        break;
      case 'file.download.ack':
        this.files.onDownloadAck(msg.id);
        break;
      case 'file.download.cancel':
        this.files.onDownloadCancel(msg.id);
        break;
      default:
        log.debug('ignoring unknown message type', { t: msg.t });
    }
  }

  #onBinary(data) {
    const frame = decodeFrame(data);
    if (!frame) return;
    if (frame.kind === KIND_WS_DATA) this.wsp.onData(frame.id, frame.flags, frame.payload);
    else if (frame.kind === KIND_HTTP_BODY) this.http.onBody(frame.id, frame.flags, frame.payload);
    else if (frame.kind === KIND_FILE_UPLOAD) this.files.onUploadData(frame.id, frame.flags, frame.payload);
  }

  #sendAuth(hello) {
    if (hello.v !== config.protocolVersion) {
      log.error('hub speaks a protocol version this agent does not', { hubVersion: hello.v });
      this.#teardown(4400, 'version mismatch');
      return;
    }
    const proof = crypto.createHmac('sha256', this.secret).update(String(hello.nonce), 'utf8').digest('hex');
    this.sendJson({
      t: 'auth',
      v: config.protocolVersion,
      agent: config.agentName,
      ts: Math.floor(Date.now() / 1000),
      proof,
      agentVersion: config.version,
    });
  }

  async #onReq(msg) {
    try {
      const result = await dispatch(msg.method, msg.params);
      this.sendJson({ t: 'res', id: msg.id, ok: true, result });
    } catch (err) {
      const error = toWireError(err);
      log.warn('rpc failed', { method: msg.method, code: error.code, message: error.message });
      this.sendJson({ t: 'res', id: msg.id, ok: false, error });
    }
  }

  #startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.sendJson({ t: 'ping', id: `a-${Date.now()}` });
    }, PING_MS);
  }

  #resetIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.warn('tunnel idle, reconnecting');
      this.#teardown(4000, 'idle');
    }, IDLE_MS);
  }

  #teardown(code, reason) {
    clearTimeout(this.idleTimer);
    clearInterval(this.pingTimer);
    if (this.http) this.http.closeAll();
    if (this.wsp) this.wsp.closeAll();
    if (this.files) this.files.closeAll();
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
        this.ws.terminate();
      }
      setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
      }, 2000).unref();
    }
  }

  #afterClose() {
    clearTimeout(this.idleTimer);
    clearInterval(this.pingTimer);
    if (this.http) this.http.closeAll();
    if (this.wsp) this.wsp.closeAll();
    if (this.files) this.files.closeAll();
    this.authed = false;
    if (this.stopped) return;
    const ceiling = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** this.attempt);
    const delay = Math.floor(Math.random() * ceiling);
    this.attempt = Math.min(this.attempt + 1, 6);
    log.info('reconnecting', { inMs: delay, attempt: this.attempt });
    setTimeout(() => this.#connect(), delay);
  }
}
