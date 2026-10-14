import http from 'node:http';
import { config } from './config.js';
import { KIND_HTTP_BODY, BODY_FINAL, encodeFrame } from './frames.js';
import { login, invalidateCookie } from './zellijweb.js';
import { toWireError, RpcError } from './errors.js';
import { log } from './log.js';

const MAX_REQUEST_BODY = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

const STRIP_REQUEST = new Set([
  'cookie', 'authorization', 'host', 'connection', 'upgrade', 'keep-alive',
  'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'te', 'trailer',
  'upgrade-insecure-requests', 'content-length',
]);
const STRIP_RESPONSE = new Set([
  'set-cookie', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'trailer',
]);

function cleanRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (STRIP_REQUEST.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function cleanResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (STRIP_RESPONSE.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export class HttpProxy {
  constructor(link) {
    this.link = link;
    this.open = new Map();
  }

  onReq(msg) {
    const id = msg.id >>> 0;
    const entry = { id, msg, body: [], size: 0, done: !msg.hasBody, cancelled: false, upstream: null };
    this.open.set(id, entry);
    if (entry.done) this.#issue(entry, false);
  }

  onBody(id, flags, payload) {
    const entry = this.open.get(id >>> 0);
    if (!entry || entry.done) return;
    entry.size += payload.length;
    if (entry.size > MAX_REQUEST_BODY) {
      this.#fail(entry, new RpcError('bad_request', 'request body exceeds 8 MiB', { id }));
      return;
    }
    if (payload.length) entry.body.push(Buffer.from(payload));
    if (flags & BODY_FINAL) {
      entry.done = true;
      this.#issue(entry, false);
    }
  }

  onCancel(id) {
    const entry = this.open.get(id >>> 0);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.upstream) entry.upstream.destroy();
    this.open.delete(entry.id);
  }

  closeAll() {
    for (const entry of this.open.values()) {
      if (entry.upstream) entry.upstream.destroy();
    }
    this.open.clear();
  }

  async #issue(entry, isRetry) {
    let cookie;
    try {
      cookie = await login();
    } catch (err) {
      this.#fail(entry, err);
      return;
    }
    if (entry.cancelled) return;

    const body = Buffer.concat(entry.body);
    const headers = cleanRequestHeaders(entry.msg.headers);
    headers.host = `${config.webHost}:${config.webPort}`;
    headers.cookie = cookie;
    if (body.length) headers['content-length'] = String(body.length);

    const req = http.request({
      host: config.webHost,
      port: config.webPort,
      method: entry.msg.method || 'GET',
      path: entry.msg.path || '/',
      headers,
    });
    entry.upstream = req;

    req.on('error', (err) => {
      if (entry.cancelled) return;
      this.#fail(entry, new RpcError('upstream_unavailable', `${err.code || 'error'} ${config.webHost}:${config.webPort}: ${err.message}`));
    });

    req.on('response', (res) => {
      if (entry.cancelled) {
        res.destroy();
        return;
      }
      if (!isRetry && (res.statusCode === 401 || res.statusCode === 403)) {
        res.resume();
        invalidateCookie();
        login({ force: true })
          .then(() => { if (!entry.cancelled) this.#issue(entry, true); })
          .catch((err) => this.#fail(entry, err));
        return;
      }
      this.link.sendJson({
        t: 'http.res',
        id: entry.id,
        status: res.statusCode,
        headers: cleanResponseHeaders(res.headers),
      });
      res.on('data', (chunk) => {
        for (let off = 0; off < chunk.length; off += CHUNK) {
          this.link.sendBinary(encodeFrame(KIND_HTTP_BODY, entry.id, 0, chunk.subarray(off, off + CHUNK)));
        }
      });
      res.on('end', () => {
        this.link.sendBinary(encodeFrame(KIND_HTTP_BODY, entry.id, BODY_FINAL, Buffer.alloc(0)));
        this.open.delete(entry.id);
      });
      res.on('error', () => {
        this.link.sendBinary(encodeFrame(KIND_HTTP_BODY, entry.id, BODY_FINAL, Buffer.alloc(0)));
        this.open.delete(entry.id);
      });
    });

    if (body.length) req.write(body);
    req.end();
  }

  #fail(entry, err) {
    if (entry.upstream) entry.upstream.destroy();
    this.open.delete(entry.id);
    log.warn('http proxy failed', { id: entry.id, path: entry.msg.path, error: String(err.message) });
    this.link.sendJson({ t: 'http.err', id: entry.id, error: toWireError(err) });
  }
}
