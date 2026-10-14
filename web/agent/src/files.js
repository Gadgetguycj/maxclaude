import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { RpcError } from './errors.js';
import { log } from './log.js';
import { listSessions, validateName } from './sessions.js';
import { encodeFrame, FILE_FINAL, KIND_FILE_DOWNLOAD } from './frames.js';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const STAT_CACHE_MS = 5000;
const BATCH_TTL_MS = 60 * 60 * 1000;

const statCache = new Map();

function wireError(err, fallback = 'file transfer failed') {
  if (err instanceof RpcError) return { code: err.code, message: err.message, detail: err.detail };
  return { code: 'internal', message: err?.message || fallback };
}

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0')) {
    throw new RpcError('bad_request', 'path must be an absolute path of at most 4096 characters');
  }
  return path.normalize(value);
}

export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\')) {
    throw new RpcError('bad_request', 'upload path is invalid');
  }
  if (path.posix.isAbsolute(value)) throw new RpcError('bad_request', 'upload path must be relative');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RpcError('bad_request', 'upload path contains an unsafe component');
  }
  return parts.join('/');
}

async function requireLiveSession(name) {
  validateName(name);
  const { sessions } = await listSessions();
  if (!sessions.some((session) => session.name === name && !session.exited)) {
    throw new RpcError('not_found', `session ${name} is not running`, { name });
  }
}

function statResult(input, st) {
  return {
    path: input,
    exists: true,
    type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
    size: st.isFile() ? st.size : null,
    mtime: st.mtimeMs,
  };
}

async function cachedStat(input) {
  const now = Date.now();
  const cached = statCache.get(input);
  if (cached && now - cached.at < STAT_CACHE_MS) return cached.result;
  let result;
  try {
    result = statResult(input, await fs.promises.stat(input));
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    result = { path: input, exists: false, type: null, size: null, mtime: null };
  }
  statCache.set(input, { at: now, result });
  if (statCache.size > 1000) {
    for (const [key, value] of statCache) if (now - value.at >= STAT_CACHE_MS) statCache.delete(key);
  }
  return result;
}

export async function statPaths(params = {}) {
  const session = validateName(params.session);
  await requireLiveSession(session);
  if (!Array.isArray(params.paths) || params.paths.length < 1 || params.paths.length > 64) {
    throw new RpcError('bad_request', 'paths must contain 1 to 64 absolute paths');
  }
  const inputs = params.paths.map(absolutePath);
  return { paths: await Promise.all(inputs.map(cachedStat)) };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function waitForAck(state) {
  return new Promise((resolve, reject) => {
    state.ackResolve = resolve;
    state.ackReject = reject;
  });
}

export class FileTransfers {
  constructor(tunnel) {
    this.tunnel = tunnel;
    this.uploads = new Map();
    this.pendingUploads = new Map();
    this.downloads = new Map();
    this.batches = new Map();
  }

  async onUploadOpen(msg) {
    const id = Number(msg.id) >>> 0;
    try {
      if (!id || this.uploads.has(id)) throw new RpcError('bad_request', 'invalid upload channel id');
      const session = validateName(msg.session);
      await requireLiveSession(session);
      const relative = safeRelativePath(msg.path);
      const declaredSize = Number(msg.size);
      const totalSize = msg.totalSize === undefined ? declaredSize : Number(msg.totalSize);
      const offset = msg.offset === undefined ? 0 : Number(msg.offset);
      const final = msg.final === undefined ? true : msg.final === true;
      const uploadId = msg.uploadId === undefined ? `single_${id}` : String(msg.uploadId);
      if (!Number.isInteger(declaredSize) || declaredSize < 0
        || !Number.isInteger(totalSize) || totalSize < 0 || totalSize > MAX_UPLOAD_BYTES) {
        throw new RpcError('bad_request', 'a single upload may not exceed 2 GB');
      }
      if (!Number.isInteger(offset) || offset < 0 || offset + declaredSize > totalSize) {
        throw new RpcError('bad_request', 'upload chunk range is invalid');
      }
      if (!/^[A-Za-z0-9_-]{8,120}$/.test(uploadId)) throw new RpcError('bad_request', 'upload id is invalid');
      if (typeof msg.batch !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(msg.batch)) {
        throw new RpcError('bad_request', 'upload batch id is invalid');
      }

      const batchKey = `${session}\0${msg.batch}`;
      let batch = this.batches.get(batchKey);
      if (!batch || Date.now() - batch.createdAt > BATCH_TTL_MS) {
        const inbox = path.join(config.filesRoot, session, 'in');
        await fs.promises.mkdir(inbox, { recursive: true, mode: 0o700 });
        let root = path.join(inbox, timestamp());
        for (let suffix = 0; ; suffix += 1) {
          const candidate = suffix ? `${root}-${suffix}` : root;
          try {
            await fs.promises.mkdir(candidate, { mode: 0o700 });
            root = candidate;
            break;
          } catch (err) {
            if (err?.code !== 'EEXIST') throw err;
          }
        }
        batch = { root, createdAt: Date.now() };
        this.batches.set(batchKey, batch);
      }

      const destination = path.join(batch.root, ...relative.split('/'));
      if (!destination.startsWith(`${batch.root}${path.sep}`)) {
        throw new RpcError('bad_request', 'upload path escaped its inbox');
      }
      let pending = this.pendingUploads.get(uploadId);
      if (pending) {
        if (pending.active || pending.session !== session || pending.relative !== relative
          || pending.batchRoot !== batch.root || pending.totalSize !== totalSize || pending.received !== offset) {
          throw new RpcError('conflict', 'upload chunk does not continue the pending file');
        }
        clearTimeout(pending.timer);
      } else {
        if (offset !== 0) throw new RpcError('conflict', 'upload cannot resume because its pending file is gone');
        await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const temp = path.join(path.dirname(destination), `.mcw-${uploadId}.part`);
        const handle = await fs.promises.open(temp, 'wx', 0o600);
        pending = {
          uploadId, session, relative, destination, batchRoot: batch.root, temp, handle,
          totalSize, received: 0, active: false, timer: null,
        };
        this.pendingUploads.set(uploadId, pending);
      }
      pending.active = true;
      this.uploads.set(id, {
        id, pending, declaredSize, received: 0, final,
        chain: Promise.resolve(),
      });
      this.tunnel.sendJson({ t: 'file.upload.ready', id, path: destination, batchRoot: batch.root });
    } catch (err) {
      this.tunnel.sendJson({ t: 'file.upload.error', id, error: wireError(err) });
    }
  }

  onUploadData(id, flags, payload) {
    const state = this.uploads.get(id);
    if (!state) return;
    state.chain = state.chain.then(async () => {
      if (state.received + payload.length > state.declaredSize) {
        throw new RpcError('bad_request', 'upload chunk exceeded its declared size');
      }
      if (payload.length) {
        await state.pending.handle.write(
          payload, 0, payload.length, state.pending.received + state.received
        );
        state.received += payload.length;
      }
      if (!(flags & FILE_FINAL)) {
        this.tunnel.sendJson({ t: 'file.upload.ack', id, received: state.received });
        return;
      }
      if (state.received !== state.declaredSize) {
        throw new RpcError('bad_request', 'upload size did not match its declaration', {
          declared: state.declaredSize, received: state.received,
        });
      }
      state.pending.received += state.received;
      state.pending.active = false;
      if (!state.final) {
        this.uploads.delete(id);
        state.pending.timer = setTimeout(() => {
          this.#failPending(state.pending, new RpcError('timeout', 'pending upload expired'));
        }, BATCH_TTL_MS);
        state.pending.timer.unref?.();
        this.tunnel.sendJson({
          t: 'file.upload.done', id, path: state.pending.destination,
          batchRoot: state.pending.batchRoot, size: state.pending.received, complete: false,
        });
        return;
      }
      if (state.pending.received !== state.pending.totalSize) {
        throw new RpcError('bad_request', 'final upload chunk did not complete the declared file size', {
          declared: state.pending.totalSize, received: state.pending.received,
        });
      }
      await state.pending.handle.sync();
      await state.pending.handle.close();
      state.pending.handle = null;
      await fs.promises.rename(state.pending.temp, state.pending.destination);
      this.uploads.delete(id);
      this.pendingUploads.delete(state.pending.uploadId);
      statCache.delete(state.pending.destination);
      log.info('file transfer complete', {
        session: state.pending.session, path: state.pending.destination,
        size: state.pending.received, direction: 'upload',
      });
      this.tunnel.sendJson({
        t: 'file.upload.done', id, path: state.pending.destination,
        batchRoot: state.pending.batchRoot,
        size: state.pending.received, complete: true,
      });
    }).catch((err) => this.#failUpload(state, err));
  }

  async #failUpload(state, err) {
    if (!this.uploads.delete(state.id)) return;
    await this.#failPending(state.pending, err);
    this.tunnel.sendJson({ t: 'file.upload.error', id: state.id, error: wireError(err) });
  }

  async #failPending(pending, err) {
    if (!pending) return;
    if (this.pendingUploads.get(pending.uploadId) === pending) this.pendingUploads.delete(pending.uploadId);
    clearTimeout(pending.timer);
    try { await pending.handle?.close(); } catch { /* closing a failed upload */ }
    try { await fs.promises.unlink(pending.temp); } catch { /* no partial file remains */ }
    log.warn('pending upload removed', {
      session: pending.session, path: pending.destination, size: pending.received, error: err?.message,
    });
  }

  onUploadCancel(id) {
    const state = this.uploads.get(Number(id) >>> 0);
    if (state) this.#failUpload(state, new RpcError('timeout', 'upload cancelled'));
  }

  async onDownloadOpen(msg) {
    const id = Number(msg.id) >>> 0;
    let state;
    try {
      if (!id || this.downloads.has(id)) throw new RpcError('bad_request', 'invalid download channel id');
      const session = validateName(msg.session);
      await requireLiveSession(session);
      const sourcePath = absolutePath(msg.path);
      const st = await fs.promises.stat(sourcePath);
      if (!st.isFile() && !st.isDirectory()) throw new RpcError('bad_request', 'path is not a file or directory');
      const directory = st.isDirectory();
      const name = path.basename(sourcePath) || 'download';
      state = {
        id, session, path: sourcePath, directory, bytes: 0, cancelled: false,
        ackResolve: null, ackReject: null, readable: null, child: null,
      };
      this.downloads.set(id, state);
      this.tunnel.sendJson({
        t: 'file.download.ready', id, path: sourcePath, type: directory ? 'directory' : 'file',
        name: directory ? `${name}.zip` : name, size: directory ? null : st.size,
      });

      let readable;
      if (directory) {
        const child = spawn('zip', ['-r', '-q', '-', `./${name}`], {
          cwd: path.dirname(sourcePath), stdio: ['ignore', 'pipe', 'pipe'],
        });
        state.child = child;
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
        state.childExit = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code) => code === 0 || state.cancelled
            ? resolve()
            : reject(new Error(`zip exited ${code}: ${stderr}`)));
        });
        readable = child.stdout;
      } else {
        readable = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_BYTES });
      }
      state.readable = readable;
      for await (const chunk of readable) {
        if (state.cancelled) throw new RpcError('timeout', 'download cancelled');
        for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
          const piece = chunk.subarray(offset, offset + CHUNK_BYTES);
          const ack = waitForAck(state);
          this.tunnel.sendBinary(encodeFrame(KIND_FILE_DOWNLOAD, id, 0, piece));
          await ack;
          state.bytes += piece.length;
        }
      }
      if (state.childExit) await state.childExit;
      const finalAck = waitForAck(state);
      this.tunnel.sendBinary(encodeFrame(KIND_FILE_DOWNLOAD, id, FILE_FINAL, Buffer.alloc(0)));
      await finalAck;
      this.downloads.delete(id);
      log.info('file transfer complete', {
        session, path: sourcePath, size: state.bytes, direction: 'download',
      });
      this.tunnel.sendJson({ t: 'file.download.done', id, path: sourcePath, size: state.bytes });
    } catch (err) {
      if (state) this.downloads.delete(id);
      this.tunnel.sendJson({ t: 'file.download.error', id, error: wireError(err) });
    }
  }

  onDownloadAck(id) {
    const state = this.downloads.get(Number(id) >>> 0);
    if (!state?.ackResolve) return;
    const resolve = state.ackResolve;
    state.ackResolve = null;
    state.ackReject = null;
    resolve();
  }

  onDownloadCancel(id) {
    const state = this.downloads.get(Number(id) >>> 0);
    if (!state) return;
    state.cancelled = true;
    state.readable?.destroy();
    state.child?.kill('SIGTERM');
    state.ackReject?.(new RpcError('timeout', 'download cancelled'));
    this.downloads.delete(state.id);
  }

  closeAll() {
    for (const state of this.uploads.values()) this.#failUpload(state, new Error('tunnel closed'));
    for (const pending of this.pendingUploads.values()) this.#failPending(pending, new Error('tunnel closed'));
    for (const state of this.downloads.values()) this.onDownloadCancel(state.id);
  }
}
