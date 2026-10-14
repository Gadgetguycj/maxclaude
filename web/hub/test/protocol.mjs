// Conformance test for the hub side of PROTOCOL.md. It speaks the agent side of
// the wire so the handshake, the RPC path, the HTTP proxy and the WebSocket proxy
// are exercised against a real socket. It is a test client, never a product path.
//
//   node test/protocol.mjs
//
// Exits non zero on the first failed assertion.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = 18311;
const UPSTREAM_PORT = 18312;
const SECRET = 'conformance-secret-value';
const PASSWORD = 'conformance-password';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-conformance-'));

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

function frameOf(buf) {
  return { kind: buf[0], id: buf.readUInt32BE(1), flags: buf[5], payload: buf.subarray(6) };
}

function makeFrame(kind, id, flags, payload) {
  const head = Buffer.allocUnsafe(6);
  head[0] = kind;
  head.writeUInt32BE(id, 1);
  head[5] = flags;
  return Buffer.concat([head, payload]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A stand in for zellij web, used only so the proxy has something real to carry.
function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session_token=leaked' });
    res.end(`upstream saw ${req.method} ${req.url}`);
  });
  const wss = new WebSocketServer({ server, path: '/ws/terminal/demo' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(Buffer.concat([Buffer.from('echo:'), data]), { binary: isBinary }));
    ws.send('hello from upstream');
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)));
}

class FakeAgent {
  constructor(secret) {
    this.secret = secret;
    this.ws = null;
    this.closeCode = null;
    this.authed = false;
    this.httpChannels = new Map();
    this.wsChannels = new Map();
    this.uploadChannels = new Map();
    this.downloadChannels = new Map();
    this.files = new Map();
    this.sessions = [{
      name: 'demo', created: 'Created 1m 2s ago', createdAt: 1000,
      activity: 'idle', activityUpdatedAt: 2400, lastResponseAt: 2000, lastActivityAt: 2400,
      exited: false, current: false
    }];
  }

  connect(url, { badProof = false, version = 1 } = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return this.onBinary(data);
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hello') {
          const proof = badProof
            ? crypto.randomBytes(32).toString('hex')
            : crypto.createHmac('sha256', this.secret).update(msg.nonce, 'ascii').digest('hex');
          ws.send(JSON.stringify({ t: 'auth', v: version, agent: 'test', ts: 1, proof, agentVersion: 'test/1' }));
          return;
        }
        if (msg.t === 'auth.ok') {
          this.authed = true;
          ws.send(JSON.stringify({ t: 'event', event: 'agent.ready', data: { host: 'the session host', webSharing: 'on' } }));
          resolve('auth.ok');
          return;
        }
        if (msg.t === 'auth.err') {
          resolve('auth.err');
          return;
        }
        this.onJson(msg);
      });
      ws.on('close', (code) => {
        this.closeCode = code;
        resolve(`closed:${code}`);
      });
      ws.on('error', () => {});
    });
  }

  onJson(msg) {
    if (msg.t === 'ping') return this.send({ t: 'pong', id: msg.id });
    if (msg.t === 'req') return this.onReq(msg);
    if (msg.t === 'http.req') return this.onHttpReq(msg);
    if (msg.t === 'ws.open') return this.onWsOpen(msg);
    if (msg.t === 'file.upload.open') {
      const batchRoot = `/tmp/mcw-files/${msg.session}/in/20260101T000000000Z`;
      const filePath = `${batchRoot}/${msg.path}`;
      this.uploadChannels.set(msg.id, { ...msg, filePath, batchRoot, chunks: [] });
      return this.send({ t: 'file.upload.ready', id: msg.id, path: filePath, batchRoot });
    }
    if (msg.t === 'file.download.open') {
      const body = this.files.get(msg.path);
      if (!body) return this.send({ t: 'file.download.error', id: msg.id, error: { code: 'not_found', message: 'file does not exist' } });
      this.downloadChannels.set(msg.id, { path: msg.path, body, stage: 0 });
      this.send({ t: 'file.download.ready', id: msg.id, path: msg.path, type: 'file', name: path.basename(msg.path), size: body.length });
      this.ws.send(makeFrame(0x04, msg.id, 0, body));
      return;
    }
    if (msg.t === 'file.download.ack') {
      const channel = this.downloadChannels.get(msg.id);
      if (!channel) return;
      if (channel.stage === 0) {
        channel.stage = 1;
        this.ws.send(makeFrame(0x04, msg.id, 0x01, Buffer.alloc(0)));
      } else {
        this.downloadChannels.delete(msg.id);
        this.send({ t: 'file.download.done', id: msg.id, path: channel.path, size: channel.body.length });
      }
      return;
    }
    if (msg.t === 'ws.close') {
      const up = this.wsChannels.get(msg.id);
      if (up) {
        up.close();
        this.wsChannels.delete(msg.id);
      }
    }
  }

  onReq(msg) {
    if (msg.method === 'sessions.list') {
      return this.send({ t: 'res', id: msg.id, ok: true, result: { sessions: this.sessions } });
    }
    if (msg.method === 'sessions.reserveViewer') {
      return this.send({ t: 'res', id: msg.id, ok: true, result: { name: msg.params.name, leaseId: 'test-lease' } });
    }
    if (msg.method === 'sessions.releaseViewer') {
      return this.send({ t: 'res', id: msg.id, ok: true, result: { released: true } });
    }
    if (msg.method === 'sessions.create') {
      if (this.sessions.some((s) => s.name === msg.params.name)) {
        return this.send({
          t: 'res',
          id: msg.id,
          ok: false,
          error: { code: 'conflict', message: `session ${msg.params.name} already exists` }
        });
      }
      this.sessions.push({
        name: msg.params.name, created: 'Created 0s ago', createdAt: Date.now(),
        activity: 'idle', activityUpdatedAt: 0, lastResponseAt: 0, lastActivityAt: 0,
        exited: false, current: false
      });
      return this.send({ t: 'res', id: msg.id, ok: true, result: { name: msg.params.name, unit: 'x.service' } });
    }
    if (msg.method === 'sessions.rename') {
      if (!this.sessions.some((s) => s.name === msg.params.oldName)) {
        return this.send({
          t: 'res', id: msg.id, ok: false,
          error: { code: 'not_found', message: `session ${msg.params.oldName} does not exist` }
        });
      }
      if (this.sessions.some((s) => s.name === msg.params.newName)) {
        return this.send({
          t: 'res', id: msg.id, ok: false,
          error: { code: 'conflict', message: `session ${msg.params.newName} already exists` }
        });
      }
      this.sessions = this.sessions.map((s) => s.name === msg.params.oldName ? { ...s, name: msg.params.newName } : s);
      return this.send({
        t: 'res', id: msg.id, ok: true,
        result: {
          oldName: msg.params.oldName,
          newName: msg.params.newName,
          renamed: true,
          oldUnit: 'old.service',
          newUnit: 'new.service',
          claudeReports: [`Session renamed to ${msg.params.newName}`]
        }
      });
    }
    if (msg.method === 'sessions.delete') {
      this.sessions = this.sessions.filter((s) => s.name !== msg.params.name);
      return this.send({ t: 'res', id: msg.id, ok: true, result: { name: msg.params.name, deleted: true } });
    }
    if (msg.method === 'transcripts.list') {
      return this.send({
        t: 'res',
        id: msg.id,
        ok: true,
        result: { transcripts: [{ uuid: '4f727bc5-b3bb-4551-97c2-03555cd90986', title: 'a conversation', mtime: 1758124800, size: 10 }] }
      });
    }
    if (msg.method === 'files.stat') {
      return this.send({
        t: 'res', id: msg.id, ok: true,
        result: { paths: msg.params.paths.map((filePath) => ({ path: filePath, exists: this.files.has(filePath), type: this.files.has(filePath) ? 'file' : null, size: this.files.get(filePath)?.length ?? null })) }
      });
    }
    return this.send({ t: 'res', id: msg.id, ok: false, error: { code: 'unsupported', message: msg.method } });
  }

  onHttpReq(msg) {
    assert.equal(msg.headers.cookie, undefined, 'the hub must not forward the browser cookie');
    const req = http.request(
      { host: '127.0.0.1', port: UPSTREAM_PORT, method: msg.method, path: msg.path, headers: {} },
      (res) => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === 'set-cookie' || k === 'transfer-encoding') continue;
          headers[k] = v;
        }
        this.send({ t: 'http.res', id: msg.id, status: res.statusCode, headers });
        res.on('data', (chunk) => this.ws.send(makeFrame(0x02, msg.id, 0, chunk)));
        res.on('end', () => this.ws.send(makeFrame(0x02, msg.id, 0x01, Buffer.alloc(0))));
      }
    );
    req.on('error', (err) => this.send({ t: 'http.err', id: msg.id, error: { code: 'upstream_unavailable', message: err.message } }));
    req.end();
  }

  onWsOpen(msg) {
    const up = new WebSocket(`ws://127.0.0.1:${UPSTREAM_PORT}${msg.path}`);
    this.lastWsId = msg.id;
    this.wsChannels.set(msg.id, up);
    up.on('open', () => this.send({ t: 'ws.opened', id: msg.id, protocol: null }));
    up.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.ws.send(makeFrame(0x01, msg.id, isBinary ? 0x02 : 0x01, payload));
    });
    up.on('close', (code, reason) => this.send({ t: 'ws.close', id: msg.id, code, reason: reason.toString() }));
    up.on('error', (err) => this.send({ t: 'ws.err', id: msg.id, error: { code: 'upstream_unavailable', message: err.message } }));
  }

  onBinary(buf) {
    const f = frameOf(buf);
    if (f.kind === 0x01) {
      const up = this.wsChannels.get(f.id);
      if (up && up.readyState === WebSocket.OPEN) up.send(f.payload, { binary: (f.flags & 0x02) !== 0 });
    }
    if (f.kind === 0x03) {
      const channel = this.uploadChannels.get(f.id);
      if (!channel) return;
      if (f.payload.length) channel.chunks.push(Buffer.from(f.payload));
      if (f.flags & 0x01) {
        const body = Buffer.concat(channel.chunks);
        this.files.set(channel.filePath, body);
        this.uploadChannels.delete(f.id);
        this.send({ t: 'file.upload.done', id: f.id, path: channel.filePath, batchRoot: channel.batchRoot, size: body.length });
      } else {
        this.send({ t: 'file.upload.ack', id: f.id });
      }
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

async function api(method, urlPath, { body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

let child;
let upstream;
let cookie;

async function boot() {
  upstream = await startUpstream();
  child = spawn('node', ['src/server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      COOKIE_SECURE: 'false',
      OPERATOR_PASSWORD: PASSWORD,
      AGENT_SECRET: SECRET,
      AGENT_PING_MS: '2000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, 15000, 'server to listen');

  const login = await api('POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie()[0].split(';')[0];
}

check('a bad proof is rejected with 4401', async () => {
  const agent = new FakeAgent('the-wrong-secret');
  const result = await agent.connect(`ws://127.0.0.1:${PORT}/agent`, { badProof: true });
  assert.equal(result, 'auth.err');
  await waitFor(async () => agent.closeCode === 4401, 3000, 'close 4401');
});

check('an unsupported protocol version is rejected', async () => {
  const agent = new FakeAgent(SECRET);
  const result = await agent.connect(`ws://127.0.0.1:${PORT}/agent`, { version: 2 });
  assert.equal(result, 'auth.err');
  await waitFor(async () => agent.closeCode === 4400, 3000, 'close 4400');
});

let live;

check('a correct proof authenticates and agent.ready is recorded', async () => {
  live = new FakeAgent(SECRET);
  const result = await live.connect(`ws://127.0.0.1:${PORT}/agent`);
  assert.equal(result, 'auth.ok');
  await waitFor(async () => {
    const state = await api('GET', '/api/state', { cookie });
    return state.json?.agent?.connected === true && state.json?.agent?.host === 'the session host';
  }, 5000, 'agent connected in /api/state');
});

check('status snapshots are retained and appear in state and the authenticated event stream', async () => {
  live.send({
    t: 'event', event: 'sessions.status',
    data: { sessions: { demo: { state: 'busy', updatedAt: 123456789, lastResponseAt: 2000, lastActivityAt: 123456789 } } }
  });
  await waitFor(async () => {
    const state = await api('GET', '/api/state', { cookie });
    return state.json?.session_status?.demo?.state === 'busy';
  }, 5000, 'retained status snapshot');
  const statusState = await api('GET', '/api/state', { cookie });
  assert.equal(statusState.json.session_status.demo.lastResponseAt, 2000);
  assert.equal(statusState.json.session_status.demo.lastActivityAt, 123456789);

  const controller = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const first = await stream.body.getReader().read();
  assert.match(Buffer.from(first.value).toString('utf8'), /event: state/);
  assert.match(Buffer.from(first.value).toString('utf8'), /"busy"/);
  controller.abort();
});

check('recents are strictly descending by the reported activity timestamp', async () => {
  const originalSessions = live.sessions;
  const points = {
    'beta-session': Date.parse('2026-09-28T22:45:17.000Z'),
    'alpha-session': Date.parse('2026-09-28T22:45:16.000Z'),
    'delta-session': Date.parse('2026-09-28T22:43:02.000Z'),
    'gamma-session': Date.parse('2026-09-28T22:44:50.000Z'),
    'epsilon-session': Date.parse('2026-09-28T22:23:18.000Z'),
  };
  live.sessions = Object.entries(points).map(([name, lastActivityAt], index) => ({
    name, created: 'Created 1h ago', createdAt: 1000 + index,
    activity: name === 'delta-session' ? 'busy' : 'idle',
    activityUpdatedAt: lastActivityAt, lastActivityAt, lastResponseAt: 0,
    exited: false, current: false,
  }));
  live.send({
    t: 'event', event: 'sessions.status',
    data: {
      sessions: Object.fromEntries(live.sessions.map((session) => [session.name, {
        state: session.activity,
        updatedAt: session.activityUpdatedAt,
        lastActivityAt: session.lastActivityAt,
        lastResponseAt: 0,
      }]))
    }
  });
  const expected = ['beta-session', 'alpha-session', 'gamma-session', 'delta-session', 'epsilon-session'];
  await waitFor(async () => {
    const state = await api('GET', '/api/state', { cookie });
    return state.json?.recents?.length === 5;
  }, 5000, 'five reported recents');
  const state = await api('GET', '/api/state', { cookie });
  assert.deepEqual(state.json.recents.map((entry) => entry.session_name), expected);
  assert.deepEqual(state.json.recents.map((entry) => entry.last_activity_at), expected.map((name) => points[name]));
  assert.equal(state.json.recents.every((entry, index, rows) => index === 0 || rows[index - 1].last_activity_at >= entry.last_activity_at), true);

  live.sessions = originalSessions;
  live.send({
    t: 'event', event: 'sessions.status',
    data: { sessions: { demo: { state: 'busy', updatedAt: 123456789, lastResponseAt: 2000, lastActivityAt: 123456789 } } }
  });
});

check('a second agent is refused with 4409', async () => {
  const second = new FakeAgent(SECRET);
  const result = await second.connect(`ws://127.0.0.1:${PORT}/agent`);
  assert.equal(result, 'closed:4409');
});

check('sessions.list reaches the tree API', async () => {
  const state = await api('GET', '/api/state', { cookie });
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.sessions.map((s) => s.name), ['demo']);
  assert.equal(state.json.sessions[0].originalCreatedAt, 1000);
});

check('the original creation time survives a recreate and keeps the earliest observation', async () => {
  live.sessions[0].createdAt = 2000;
  let state = await api('GET', '/api/state', { cookie });
  assert.equal(state.json.sessions[0].originalCreatedAt, 1000);
  live.sessions[0].createdAt = 500;
  state = await api('GET', '/api/state', { cookie });
  assert.equal(state.json.sessions[0].originalCreatedAt, 500);
});

check('transcripts are mapped to the SPA shape', async () => {
  const res = await api('GET', '/api/transcripts', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.transcripts[0].sid, '4f727bc5-b3bb-4551-97c2-03555cd90986');
  assert.equal(res.json.transcripts[0].mtime, 1758124800000);
});

check('creating a session calls the agent and files a leaf', async () => {
  const folder = await api('POST', '/api/folders', { cookie, body: { name: 'Work' } });
  const nested = await api('POST', '/api/folders', { cookie, body: { name: 'Deep', parent_id: folder.json.node.id } });
  const created = await api('POST', '/api/sessions', {
    cookie,
    body: { name: 'built', panes: 2, workdir: '/workspace', resume_sid: null, parent_id: nested.json.node.id }
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.node.parent_id, nested.json.node.id);
  assert.equal(created.json.node.panes, 2);
  assert.ok(live.sessions.some((s) => s.name === 'built'), 'the agent was asked to create it');
});

check('recents rank by live agent activity and opening does not change the order', async () => {
  const limit = await api('PUT', '/api/preferences/recent-limit', { cookie, body: { recent_limit: 3 } });
  assert.equal(limit.status, 200);
  assert.equal(limit.json.recent_limit, 3);
  let state = await api('GET', '/api/state', { cookie });
  assert.equal(state.json.recent_limit, 3);
  assert.deepEqual(state.json.recents.map((entry) => entry.session_name), ['demo', 'built']);
  live.send({
    t: 'event', event: 'sessions.status',
    data: { sessions: { demo: { state: 'idle', updatedAt: 2400, lastResponseAt: 2000, lastActivityAt: 2400 } } }
  });
  await waitFor(async () => {
    const current = await api('GET', '/api/state', { cookie });
    return current.json?.session_status?.demo?.state === 'idle';
  }, 5000, 'idle activity snapshot');
  const built = live.sessions.find((session) => session.name === 'built');
  built.activityUpdatedAt = 3000;
  built.lastActivityAt = 3000;
  live.sessions.find((session) => session.name === 'demo').lastActivityAt = 9000;
  state = await api('GET', '/api/state', { cookie });
  assert.deepEqual(state.json.recents.map((entry) => entry.session_name), ['built', 'demo']);
  assert.equal(state.json.recents[0].last_activity_at, 3000);
  live.send({
    t: 'event', event: 'sessions.status',
    data: { sessions: { demo: { state: 'busy', updatedAt: 2500, lastResponseAt: 2000, lastActivityAt: 4000 } } }
  });
  await waitFor(async () => {
    const current = await api('GET', '/api/state', { cookie });
    return current.json?.recents?.[0]?.session_name === 'demo';
  }, 5000, 'busy session first');
  const opened = await api('POST', '/api/sessions/demo/open', { cookie, body: {} });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json.recents.map((entry) => entry.session_name), ['demo', 'built']);
  state = await api('GET', '/api/state', { cookie });
  assert.deepEqual(state.json.recents.map((entry) => entry.session_name), ['demo', 'built']);

  const missing = await api('POST', '/api/sessions/not-live/open', { cookie, body: {} });
  assert.equal(missing.status, 404);

  const invalid = await api('PUT', '/api/preferences/recent-limit', { cookie, body: { recent_limit: 7 } });
  assert.equal(invalid.status, 400);
});

check('a name that is already live comes back as 409 conflict', async () => {
  const res = await api('POST', '/api/sessions', { cookie, body: { name: 'demo', panes: 1 } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'conflict');
});

check('renaming a session updates the agent and the stored leaf', async () => {
  const before = await api('GET', '/api/state', { cookie });
  const originalCreatedAt = before.json.sessions.find((session) => session.name === 'built').originalCreatedAt;
  const res = await api('POST', '/api/sessions/rename', {
    cookie,
    body: { old_name: 'built', new_name: 'built-renamed' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.node.name, 'built-renamed');
  assert.equal(res.json.node.session_name, 'built-renamed');
  assert.match(res.json.claude_reports[0], /Session renamed to built-renamed/);
  assert.ok(live.sessions.some((s) => s.name === 'built-renamed'));
  assert.ok(!live.sessions.some((s) => s.name === 'built'));
  const state = await api('GET', '/api/state', { cookie });
  assert.ok(state.json.recents.some((entry) => entry.session_name === 'built-renamed'));
  assert.equal(state.json.sessions.find((session) => session.name === 'built-renamed').originalCreatedAt, originalCreatedAt);
});

check('a folder cannot be moved into its own descendant', async () => {
  const outer = await api('POST', '/api/folders', { cookie, body: { name: 'Outer' } });
  const inner = await api('POST', '/api/folders', { cookie, body: { name: 'Inner', parent_id: outer.json.node.id } });
  const res = await api('PATCH', `/api/nodes/${outer.json.node.id}`, { cookie, body: { parent_id: inner.json.node.id } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'cycle');
});

check('a reserved session name is refused', async () => {
  const res = await api('POST', '/api/sessions', { cookie, body: { name: 'assets', panes: 1 } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'reserved_name');
});

check('authenticated uploads and downloads stream through the agent and enter transfer history', async () => {
  const body = crypto.randomBytes(1024 * 1024 + 17);
  const query = new URLSearchParams({ batch: 'batch_conformance', path: 'proof.bin', size: String(body.length) });
  const uploaded = await fetch(`http://127.0.0.1:${PORT}/api/sessions/demo/uploads?${query}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body
  });
  assert.equal(uploaded.status, 200);
  const uploadJson = await uploaded.json();
  assert.equal(uploadJson.size, body.length);
  assert.deepEqual(live.files.get(uploadJson.path), body);

  const stat = await api('POST', '/api/files/stat', {
    cookie, body: { session: 'demo', paths: [uploadJson.path, '/missing'] }
  });
  assert.equal(stat.status, 200);
  assert.equal(stat.json.paths[0].exists, true);
  assert.equal(stat.json.paths[1].exists, false);

  const downloadQuery = new URLSearchParams({ session: 'demo', path: uploadJson.path });
  const downloaded = await fetch(`http://127.0.0.1:${PORT}/api/files/download?${downloadQuery}`, { headers: { cookie } });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), body);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);

  await waitFor(async () => {
    const history = await api('GET', '/api/sessions/demo/files', { cookie });
    return history.json?.transfers?.length === 2;
  }, 3000, 'transfer history');
  const history = await api('GET', '/api/sessions/demo/files', { cookie });
  assert.deepEqual(history.json.transfers.map((entry) => entry.direction), ['download', 'upload']);
  assert.ok(history.json.transfers.every((entry) => entry.path === uploadJson.path && entry.size === body.length));
});

check('file transfer routes require login and reject uploads over 2 GB', async () => {
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/sessions/demo/uploads?batch=batch_noauth&path=x&size=1`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('x')
  });
  assert.equal(noAuth.status, 401);
  const tooLarge = await fetch(`http://127.0.0.1:${PORT}/api/sessions/demo/uploads?batch=batch_large&path=x&size=${2 * 1024 * 1024 * 1024 + 1}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(0)
  });
  assert.equal(tooLarge.status, 400);
  const noAuthDownload = await fetch(`http://127.0.0.1:${PORT}/api/files/download?session=demo&path=/tmp/x`);
  assert.equal(noAuthDownload.status, 401);
});

check('the HTTP proxy carries a body and strips the upstream set-cookie', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/zellij-assets/index.js`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'upstream saw GET /zellij-assets/index.js');
  assert.equal(res.headers.get('set-cookie'), null, 'the zellij cookie must not reach the browser');
});

check('the HTTP proxy refuses an unauthenticated request', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/zellij-assets/index.js`);
  assert.equal(res.status, 401);
});

check('the maintained terminal asset wins before the upstream asset proxy', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/assets/terminal.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /WarmTerminalLifecycle/);
});

check('/t/<name> redirects onto the canonical path', async () => {
  const res = await api('GET', '/t/demo', { cookie });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/demo');
});

check('the WebSocket proxy carries bytes both ways', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal/demo?web_client_id=abc`, { headers: { cookie } });
  const seen = [];
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send('ping-from-browser'));
    ws.on('message', (data) => {
      seen.push(data.toString());
      if (seen.length === 2) resolve();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('websocket proxy timed out')), 5000);
  });
  assert.ok(seen.includes('hello from upstream'), 'upstream to browser');
  assert.ok(seen.includes('echo:ping-from-browser'), 'browser to upstream');
  ws.close();
});

check('an unauthenticated WebSocket upgrade is refused', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal/demo`);
  const outcome = await new Promise((resolve) => {
    ws.on('open', () => resolve('opened'));
    ws.on('error', (err) => resolve(err.message));
    setTimeout(() => resolve('timeout'), 4000);
  });
  assert.match(outcome, /401/, `expected a 401 on upgrade, got ${outcome}`);
});

// A browser tab that is killed leaves the upstream socket closing abnormally, which puts a
// reserved close code on the tunnel. ws throws on those instead of returning an error, and the
// throw took the whole hub down. These drive the real proxy close path, not a helper.
async function openProxied(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal/demo?web_client_id=${label}`, { headers: { cookie } });
  await new Promise((resolve, reject) => {
    ws.on('message', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`the proxied socket for ${label} never carried bytes`)), 5000);
  });
  return { ws, id: live.lastWsId };
}

function closeCodeOf(ws) {
  return new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
    setTimeout(() => resolve('never closed'), 5000);
  });
}

async function assertHubAlive() {
  assert.equal(child.exitCode, null, 'the hub process exited');
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.ok(res.ok, 'the hub stopped serving');
}

check('a reserved close code (1006) from the agent does not kill the hub', async () => {
  const { ws, id } = await openProxied('reserved-code');
  const seen = closeCodeOf(ws);
  live.send({ t: 'ws.close', id, code: 1006, reason: 'abnormal closure' });
  assert.equal(await seen, 1011, 'the browser socket is closed with a code ws will put on the wire');
  await assertHubAlive();
});

check('a non string close reason from the agent does not kill the hub', async () => {
  const { ws, id } = await openProxied('number-reason');
  const seen = closeCodeOf(ws);
  live.send({ t: 'ws.err', id, error: { code: 4001, message: '' } });
  assert.equal(await seen, 1011);
  await assertHubAlive();
});

check('an oversized close reason from the agent does not kill the hub', async () => {
  const { ws, id } = await openProxied('long-reason');
  const seen = closeCodeOf(ws);
  live.send({ t: 'ws.close', id, code: 1000, reason: 'é'.repeat(200) });
  assert.equal(await seen, 1000);
  await assertHubAlive();
});

check('deleting a leaf destroys the real session', async () => {
  const state = await api('GET', '/api/state', { cookie });
  const leaf = state.json.tree.find((n) => n.session_name === 'built-renamed');
  const res = await api('DELETE', `/api/sessions/${leaf.id}`, { cookie });
  assert.equal(res.status, 200);
  assert.ok(!live.sessions.some((s) => s.name === 'built-renamed'), 'the agent was asked to delete it');
  const after = await api('GET', '/api/state', { cookie });
  assert.ok(!after.json.recents.some((entry) => entry.session_name === 'built-renamed'));
});

check('when the agent drops, sessions goes null and mutations fail', async () => {
  live.ws.close();
  await waitFor(async () => {
    const state = await api('GET', '/api/state', { cookie });
    return state.json.agent.connected === false && state.json.sessions === null;
  }, 5000, 'agent to read as disconnected');
  const res = await api('POST', '/api/sessions', { cookie, body: { name: 'nope', panes: 1 } });
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'agent_disconnected');
  const state = await api('GET', '/api/state', { cookie });
  assert.ok(state.json.tree.length > 0, 'the tree is still served from the database');
});

async function run() {
  await boot();
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      process.stdout.write(`ok    ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
    }
  }
  child.kill('SIGTERM');
  upstream.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  child?.kill('SIGTERM');
  upstream?.close();
  process.exit(1);
});
