#!/usr/bin/env node
// Real end to end test of the agent host half.
//
// It stands up a hub that speaks PROTOCOL.md v1, runs the real mcw-agent against
// it, and then drives a throwaway maxclaude session all the way to live terminal
// bytes in the browser path. Nothing about zellij, systemd or claude is faked.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import {
  encodeFrame, decodeFrame, KIND_WS_DATA, KIND_HTTP_BODY, KIND_FILE_UPLOAD, KIND_FILE_DOWNLOAD,
  WS_TEXT, BODY_FINAL, FILE_FINAL,
} from '../src/frames.js';
import { stripAnsi } from '../src/exec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ENTRY = path.join(HERE, '..', 'src', 'index.js');
const ZELLIJ = process.env.MCW_ZELLIJ_BIN || '';
const MAXCLAUDE_CFG = process.env.MCW_MAXCLAUDE_CFG || '';
const TRANSCRIPTS = process.env.MCW_TRANSCRIPT_DIR || '';
if (!ZELLIJ || !MAXCLAUDE_CFG || !TRANSCRIPTS || !process.env.MCW_FILES_ROOT) {
  console.log('SKIP: set MCW_ZELLIJ_BIN, MCW_MAXCLAUDE_CFG, MCW_TRANSCRIPT_DIR, and MCW_FILES_ROOT for integration tests');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const results = [];

function say(msg) {
  process.stdout.write(`${new Date().toISOString()}  ${msg}\n`);
}

function check(name, ok, detail) {
  step += 1;
  results.push({ name, ok });
  say(`${ok ? 'PASS' : 'FAIL'}  ${step}. ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) throw new Error(`assertion failed: ${name}${detail ? ` (${detail})` : ''}`);
}

function zellijSessions() {
  try {
    const out = execFileSync(ZELLIJ, ['list-sessions', '-n'], { encoding: 'utf8' });
    return stripAnsi(out).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    const out = `${e.stdout || ''}`;
    return stripAnsi(out).split('\n').map((l) => l.trim()).filter(Boolean);
  }
}

class Hub {
  constructor(secret) {
    this.secret = secret;
    this.rpcSeq = 0;
    this.chanSeq = 0;
    this.pendingRpc = new Map();
    this.pendingHttp = new Map();
    this.channels = new Map();
    this.files = new Map();
    this.events = [];
    this.ws = null;
    this.readyResolve = null;
    this.ready = new Promise((r) => { this.readyResolve = r; });
  }

  async listen() {
    this.server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/agent')) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#onAgent(ws));
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    return this.server.address().port;
  }

  close() {
    if (this.ws) try { this.ws.close(1001, 'test over'); } catch { /* closing anyway */ }
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }

  #onAgent(ws) {
    this.ws = ws;
    this.nonce = crypto.randomBytes(32).toString('hex');
    ws.send(JSON.stringify({ t: 'hello', v: 1, nonce: this.nonce, server: 'mcw-test-hub/1.0.0' }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) this.#onBinary(data);
      else this.#onText(JSON.parse(data.toString()));
    });
  }

  #onText(msg) {
    switch (msg.t) {
      case 'auth': {
        const want = crypto.createHmac('sha256', this.secret).update(this.nonce, 'utf8').digest('hex');
        if (msg.proof !== want) {
          this.ws.send(JSON.stringify({ t: 'auth.err', error: { code: 'unauthorized', message: 'bad proof' } }));
          this.ws.close(4401, 'unauthorized');
          return;
        }
        this.ws.send(JSON.stringify({ t: 'auth.ok', conn: 'c-test', serverTime: Math.floor(Date.now() / 1000) }));
        break;
      }
      case 'event':
        this.events.push(msg);
        if (msg.event === 'agent.ready') this.readyResolve(msg.data);
        break;
      case 'ping':
        this.ws.send(JSON.stringify({ t: 'pong', id: msg.id }));
        break;
      case 'pong':
        break;
      case 'res': {
        const p = this.pendingRpc.get(msg.id);
        if (!p) return;
        this.pendingRpc.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error.message), { wire: msg.error }));
        break;
      }
      case 'http.res': {
        const p = this.pendingHttp.get(msg.id);
        if (!p) return;
        p.status = msg.status;
        p.headers = msg.headers;
        break;
      }
      case 'http.err': {
        const p = this.pendingHttp.get(msg.id);
        if (!p) return;
        this.pendingHttp.delete(msg.id);
        p.reject(Object.assign(new Error(msg.error.message), { wire: msg.error }));
        break;
      }
      case 'ws.opened': {
        const c = this.channels.get(msg.id);
        if (c) c.openResolve(c);
        break;
      }
      case 'ws.err': {
        const c = this.channels.get(msg.id);
        if (c) {
          this.channels.delete(msg.id);
          c.openReject(Object.assign(new Error(msg.error.message), { wire: msg.error }));
        }
        break;
      }
      case 'ws.close': {
        const c = this.channels.get(msg.id);
        if (c) {
          c.closed = { code: msg.code, reason: msg.reason };
          this.channels.delete(msg.id);
        }
        break;
      }
      case 'file.upload.ready': {
        const file = this.files.get(msg.id);
        if (file) file.ready(msg);
        break;
      }
      case 'file.upload.ack': {
        const file = this.files.get(msg.id);
        if (file) file.ack();
        break;
      }
      case 'file.upload.done':
      case 'file.download.done': {
        const file = this.files.get(msg.id);
        if (file) {
          this.files.delete(msg.id);
          file.resolve(msg);
        }
        break;
      }
      case 'file.download.ready': {
        const file = this.files.get(msg.id);
        if (file) file.meta = msg;
        break;
      }
      case 'file.upload.error':
      case 'file.download.error': {
        const file = this.files.get(msg.id);
        if (file) {
          this.files.delete(msg.id);
          file.reject(Object.assign(new Error(msg.error.message), { wire: msg.error }));
        }
        break;
      }
      default:
        break;
    }
  }

  #onBinary(data) {
    const f = decodeFrame(data);
    if (!f) return;
    if (f.kind === KIND_HTTP_BODY) {
      const p = this.pendingHttp.get(f.id);
      if (!p) return;
      if (f.payload.length) p.chunks.push(Buffer.from(f.payload));
      if (f.flags & BODY_FINAL) {
        this.pendingHttp.delete(f.id);
        p.resolve({ status: p.status, headers: p.headers, body: Buffer.concat(p.chunks) });
      }
      return;
    }
    if (f.kind === KIND_WS_DATA) {
      const c = this.channels.get(f.id);
      if (c) c.onData(Buffer.from(f.payload), (f.flags & WS_TEXT) !== 0);
      return;
    }
    if (f.kind === KIND_FILE_DOWNLOAD) {
      const file = this.files.get(f.id);
      if (!file) return;
      if (f.payload.length) file.chunks.push(Buffer.from(f.payload));
      this.ws.send(JSON.stringify({ t: 'file.download.ack', id: f.id }));
    }
  }

  rpc(method, params, timeoutMs = 90000) {
    const id = `r-${++this.rpcSeq}`;
    this.ws.send(JSON.stringify({ t: 'req', id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  httpRequest(method, reqPath, headers = {}, body = null) {
    const id = ++this.chanSeq;
    const entry = { chunks: [], status: null, headers: null };
    const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    this.pendingHttp.set(id, entry);
    this.ws.send(JSON.stringify({ t: 'http.req', id, method, path: reqPath, headers, hasBody: body !== null }));
    if (body !== null) {
      this.ws.send(encodeFrame(KIND_HTTP_BODY, id, BODY_FINAL, Buffer.from(body)), { binary: true });
    }
    return promise;
  }

  wsOpen(wsPath, onData) {
    const id = ++this.chanSeq;
    const chan = { id, onData, closed: null, bytes: 0 };
    chan.send = (payload, isText = true) => {
      this.ws.send(encodeFrame(KIND_WS_DATA, id, isText ? WS_TEXT : 0x02, Buffer.from(payload)), { binary: true });
    };
    chan.close = () => this.ws.send(JSON.stringify({ t: 'ws.close', id, code: 1000, reason: 'test done' }));
    const promise = new Promise((resolve, reject) => { chan.openResolve = resolve; chan.openReject = reject; });
    this.channels.set(id, chan);
    this.ws.send(JSON.stringify({ t: 'ws.open', id, path: wsPath, protocols: [], headers: {} }));
    return promise;
  }

  upload(session, relativePath, body) {
    const id = ++this.chanSeq;
    const file = {};
    const promise = new Promise((resolve, reject) => { file.resolve = resolve; file.reject = reject; });
    file.ready = () => {
      file.ack = () => {
        file.ack = () => {};
        this.ws.send(encodeFrame(KIND_FILE_UPLOAD, id, FILE_FINAL, Buffer.alloc(0)), { binary: true });
      };
      this.ws.send(encodeFrame(KIND_FILE_UPLOAD, id, 0, body), { binary: true });
    };
    this.files.set(id, file);
    this.ws.send(JSON.stringify({
      t: 'file.upload.open', id, session, batch: `batch_${crypto.randomBytes(6).toString('hex')}`,
      path: relativePath, size: body.length,
    }));
    return promise;
  }

  download(session, filePath) {
    const id = ++this.chanSeq;
    const file = { chunks: [] };
    const promise = new Promise((resolve, reject) => {
      file.resolve = (msg) => resolve({ ...msg, meta: file.meta, body: Buffer.concat(file.chunks) });
      file.reject = reject;
    });
    this.files.set(id, file);
    this.ws.send(JSON.stringify({ t: 'file.download.open', id, session, path: filePath }));
    return promise;
  }
}

function transcriptWords(uuid) {
  const file = path.join(TRANSCRIPTS, `${uuid}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const texts = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message && o.message.content;
    let t = typeof c === 'string' ? c : Array.isArray(c)
      ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '';
    t = t.trim();
    if (!t || t.startsWith('<') || t.startsWith('Caveat:')) continue;
    texts.push(t);
  }
  const tail = texts.slice(-4).join(' ');
  const stop = new Set([
    'claude', 'about', 'there', 'their', 'which', 'would', 'should', 'could', 'these', 'those',
    'with', 'that', 'this', 'have', 'from', 'your', 'what', 'when', 'then', 'will', 'into',
    'just', 'make', 'need', 'want', 'only', 'also', 'here', 'they', 'been', 'does', 'file',
  ]);
  const words = [...new Set(tail.toLowerCase().match(/[a-z]{4,}/g) || [])].filter((w) => !stop.has(w));
  return { texts, words: words.slice(0, 8) };
}

async function main() {
  const name = `mcw-test-${crypto.randomBytes(3).toString('hex')}`;
  const renamedName = `${name}-renamed`;
  const secret = crypto.randomBytes(32).toString('hex');
  const secretFile = path.join(os.tmpdir(), `mcw-test-secret-${process.pid}`);
  fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 });

  const hub = new Hub(secret);
  const port = await hub.listen();
  say(`hub listening on ws://127.0.0.1:${port}/agent, test session name ${name}`);

  const agent = spawn(process.execPath, [AGENT_ENTRY], {
    env: {
      ...process.env,
      MCW_HUB_URL: `ws://127.0.0.1:${port}/agent`,
      MCW_SECRET_FILE: secretFile,
      MCW_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (d) => process.stdout.write(d.toString().replace(/^/gm, 'agent | ')));
  agent.stderr.on('data', (d) => process.stdout.write(d.toString().replace(/^/gm, 'agent ! ')));

  let created = false;
  let unitName = null;
  let activeName = name;
  try {
    const info = await Promise.race([
      hub.ready,
      sleep(45000).then(() => { throw new Error('agent never authenticated within 45s'); }),
    ]);
    check('agent dialled out, authenticated and announced itself',
      info && info.host === os.hostname(), `host=${info.host} zellij=${info.zellijVersion}`);
    check('zellij web_sharing is on', info.webSharing === 'on', `webSharing=${info.webSharing}`);
    check('zellij web server is online', info.webServer.running === true, info.webServer.status);

    const tl = await hub.rpc('transcripts.list', { limit: 500 });
    check('transcripts.list returned real transcripts', tl.transcripts.length > 0,
      `${tl.transcripts.length} of ${tl.total} listed, newest "${tl.transcripts[0].title.slice(0, 48)}"`);

    const pick = process.env.MCW_TEST_RESUME_SID
      ? tl.transcripts.find((t) => t.uuid === process.env.MCW_TEST_RESUME_SID)
      : tl.transcripts
        .filter((t) => t.title !== t.uuid && t.size > 500 && t.size < 65536
          && t.mtime < Math.floor(Date.now() / 1000) - 3600)
        .sort((a, b) => a.size - b.size)[0];
    if (!pick) throw new Error('no suitable transcript to resume');
    const { texts, words } = transcriptWords(pick.uuid);
    say(`resuming transcript ${pick.uuid} (${pick.size} bytes): "${pick.title}"`);
    say(`terminal must show one of these words: ${words.join(', ')}`);
    check('chosen transcript exists on disk',
      fs.existsSync(path.join(TRANSCRIPTS, `${pick.uuid}.jsonl`)) && texts.length > 0,
      `${texts.length} text messages`);

    const before = zellijSessions();
    check('test session name is not in use', !before.some((l) => l.startsWith(`${name} `)),
      `${before.length} sessions already on the box, untouched`);

    const badName = await hub.rpc('sessions.create', { name: 'not a valid name' }).then(
      () => null, (e) => e.wire);
    check('a bad name is refused with the documented error shape',
      badName && badName.code === 'bad_request' && typeof badName.message === 'string',
      JSON.stringify(badName));

    const missingSid = await hub.rpc('sessions.create',
      { name, resumeSid: '00000000-0000-0000-0000-000000000000' }).then(() => null, (e) => e.wire);
    check('a missing transcript is refused before anything is written',
      missingSid && missingSid.code === 'not_found'
        && !fs.existsSync(path.join(MAXCLAUDE_CFG, 'sessions', `${name}.env`)),
      JSON.stringify(missingSid));

    const unknown = await hub.rpc('sessions.nope', {}).then(() => null, (e) => e.wire);
    check('an unknown method is refused', unknown && unknown.code === 'unsupported', JSON.stringify(unknown));

    const escaped = execFileSync('systemd-escape', [name], { encoding: 'utf8' }).trim();
    const createdRes = await hub.rpc('sessions.create', {
      name, panes: 1, workdir: process.env.MCW_DEFAULT_WORKDIR || process.env.HOME, resumeSid: pick.uuid,
    });
    created = true;
    unitName = `maxclaude-named@${escaped}.service`;
    check('sessions.create started the real maxclaude unit', createdRes.unit === unitName,
      `${createdRes.unit} env=${createdRes.envFile}`);

    await sleep(5000);
    const stable = zellijSessions().some((l) => l.startsWith(`${name} `));
    if (!stable) {
      const j = execFileSync('journalctl', ['--user', '-u', unitName, '-n', '30', '--no-pager'], { encoding: 'utf8' });
      say(`unit journal after the session vanished:\n${j}`);
    }
    check('the session is still alive five seconds later', stable, 'no immediate exit');

    const envText = fs.readFileSync(path.join(MAXCLAUDE_CFG, 'sessions', `${name}.env`), 'utf8');
    const panesText = fs.readFileSync(path.join(MAXCLAUDE_CFG, `${name}.panes`), 'utf8');
    check('env file carries the resume id the way maxclaude-restore writes it',
      envText.includes(`MAXCLAUDE_RESUME_SID=${pick.uuid}`) && panesText.trim() === '1',
      JSON.stringify(envText));

    const live = zellijSessions();
    check('zellij list-sessions shows the new session',
      live.some((l) => l.startsWith(`${name} `)),
      live.find((l) => l.startsWith(`${name} `)));

    const sl = await hub.rpc('sessions.list');
    check('sessions.list over the tunnel agrees',
      sl.sessions.some((s) => s.name === name && !s.exited),
      `${sl.sessions.length} sessions listed`);
    const listed = sl.sessions.find((s) => s.name === name);
    check('sessions.list reports a real creation timestamp and live activity',
      Number.isInteger(listed?.createdAt) && listed.createdAt > 0
        && ['busy', 'background', 'idle', 'absent', 'unknown'].includes(listed.activity)
        && Number.isInteger(listed.activityUpdatedAt),
      JSON.stringify(listed));

    const transferBody = Buffer.from(`mcw transfer ${crypto.randomBytes(16).toString('hex')}\n`);
    const uploaded = await hub.upload(name, 'proof folder/transfer.txt', transferBody);
    check('streamed upload landed in the per-session inbox',
      uploaded.path.startsWith(`${process.env.MCW_FILES_ROOT || ''}/${name}/in/`) && fs.existsSync(uploaded.path),
      uploaded.path);
    check('streamed upload bytes are exact',
      crypto.createHash('sha256').update(fs.readFileSync(uploaded.path)).digest('hex')
        === crypto.createHash('sha256').update(transferBody).digest('hex'),
      `${transferBody.length} bytes`);
    const stats = await hub.rpc('files.stat', { session: name, paths: [uploaded.path, `${uploaded.path}.missing`] });
    check('files.stat returns real path state from agent host',
      stats.paths[0].exists === true && stats.paths[0].type === 'file' && stats.paths[1].exists === false,
      JSON.stringify(stats.paths));
    const downloaded = await hub.download(name, uploaded.path);
    check('streamed download bytes match the uploaded file',
      crypto.createHash('sha256').update(downloaded.body).digest('hex')
        === crypto.createHash('sha256').update(transferBody).digest('hex'),
      `${downloaded.body.length} bytes`);

    const sess = await hub.httpRequest('POST', '/session', { 'content-type': 'application/json' }, '{}');
    const sessBody = JSON.parse(sess.body.toString());
    check('proxied POST /session authenticated server side', sess.status === 200 && !!sessBody.web_client_id,
      `web_client_id=${sessBody.web_client_id}`);
    const headerNames = Object.keys(sess.headers || {}).map((h) => h.toLowerCase());
    check('no zellij cookie or token leaks back through the proxy',
      !headerNames.includes('set-cookie') && !sess.body.toString().includes('session_token'),
      `response headers: ${headerNames.join(', ') || 'none'}`);

    let terminalBytes = 0;
    let terminalText = '';
    let controlOpened = false;
    const webClientId = sessBody.web_client_id;

    const onTerminal = async (payload) => {
      terminalBytes += payload.length;
      terminalText += payload.toString('utf8');
      if (!controlOpened) {
        controlOpened = true;
        const control = await hub.wsOpen('/ws/control', () => {});
        control.send(JSON.stringify({
          web_client_id: webClientId,
          payload: { type: 'TerminalResize', rows: 45, cols: 160 },
        }));
        say('control socket open, sent TerminalResize 45x160');
      }
    };

    const termPath = `/ws/terminal/${name}?web_client_id=${encodeURIComponent(webClientId)}`;
    const term = await hub.wsOpen(termPath, onTerminal);
    check('terminal websocket attached through the tunnel', !!term, termPath);

    const deadline = Date.now() + 120000;
    let plain = '';
    let hits = [];
    while (Date.now() < deadline) {
      await sleep(1000);
      plain = stripAnsi(terminalText).toLowerCase();
      hits = words.filter((w) => plain.includes(w));
      if (terminalBytes > 1000 && hits.length >= 2) break;
    }

    check('more than 1000 bytes of terminal output arrived', terminalBytes > 1000, `${terminalBytes} bytes`);

    const control = crypto.randomBytes(8).toString('hex');
    check('negative control string is absent from the terminal', !plain.includes(control), control);

    check('the resumed conversation is visible in the terminal', hits.length >= 2,
      `matched ${hits.join(', ')} from transcript ${pick.uuid}`);

    const psOut = execFileSync('/bin/sh', ['-c', `ps -eo args | grep -F -- '--resume ${pick.uuid}' | grep -v grep || true`], { encoding: 'utf8' }).trim();
    check('the pane really ran claude --resume with that uuid', psOut.includes(`--resume ${pick.uuid}`),
      psOut.split('\n')[0].slice(0, 160));
    check('the pane started with Remote Control named after the maxclaude session',
      psOut.includes(`--remote-control=${name}`), psOut.split('\n')[0].slice(0, 200));

    const plainRaw = stripAnsi(terminalText);
    const at = plainRaw.toLowerCase().indexOf(hits[0]);
    const excerpt = plainRaw.slice(Math.max(0, at - 400), at + 400)
      .replace(/[\u2500-\u257f\u2580-\u259f]{2,}/g, '--')
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
      .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    say(`--- live terminal around the resumed message ---\n${excerpt}\n--- end of terminal excerpt ---`);

    term.close();
    await sleep(500);

    const renamedEscaped = execFileSync('systemd-escape', [renamedName], { encoding: 'utf8' }).trim();
    const rename = await hub.rpc('sessions.rename', { oldName: name, newName: renamedName });
    activeName = renamedName;
    unitName = `maxclaude-named@${renamedEscaped}.service`;
    check('sessions.rename changed the zellij name and escaped systemd mapping',
      rename.renamed === true && rename.newUnit === unitName,
      JSON.stringify({ oldUnit: rename.oldUnit, newUnit: rename.newUnit }));
    check('Claude reported the new phone-facing session name',
      rename.claudeReports.some((report) => report.toLowerCase().includes(renamedName.toLowerCase())),
      rename.claudeReports.join('\n').slice(-1000));

    const renamedSessions = zellijSessions();
    check('zellij lists only the renamed session',
      renamedSessions.some((l) => l.startsWith(`${renamedName} `))
        && !renamedSessions.some((l) => l.startsWith(`${name} `)),
      renamedSessions.find((l) => l.startsWith('mcw-test-')) || 'no test session');
    check('the maxclaude env and panes files moved to the new name',
      fs.existsSync(path.join(MAXCLAUDE_CFG, 'sessions', `${renamedName}.env`))
        && fs.existsSync(path.join(MAXCLAUDE_CFG, `${renamedName}.panes`))
        && !fs.existsSync(path.join(MAXCLAUDE_CFG, 'sessions', `${name}.env`))
        && !fs.existsSync(path.join(MAXCLAUDE_CFG, `${name}.panes`)),
      renamedName);
    const activeUnit = execFileSync('systemctl', ['--user', 'is-active', unitName], { encoding: 'utf8' }).trim();
    check('the renamed escaped systemd unit is active', activeUnit === 'active', `${unitName}=${activeUnit}`);

    const statusDir = path.join(process.env.MCW_STATE_DIR || '', renamedName);
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(path.join(statusDir, 'delete-proof.json'), '{}\n');
    const del = await hub.rpc('sessions.delete', { name: renamedName });
    created = false;
    check('sessions.delete reported success', del.deleted === true, JSON.stringify(del));
    check('sessions.delete removed panes, env and status state',
      !fs.existsSync(path.join(MAXCLAUDE_CFG, 'sessions', `${renamedName}.env`))
        && !fs.existsSync(path.join(MAXCLAUDE_CFG, `${renamedName}.panes`))
        && !fs.existsSync(statusDir),
      JSON.stringify(del.removed));

    const after = zellijSessions();
    check('zellij list-sessions no longer shows the session',
      !after.some((l) => l.startsWith(`${name} `)) && !after.some((l) => l.startsWith(`${renamedName} `)),
      `${after.length} sessions remain`);

    const untouched = before.filter((l) => !l.startsWith(`${name} `)).map((l) => l.split(' ')[0]);
    const stillThere = untouched.every((n) => after.some((l) => l.startsWith(`${n} `)));
    check('every pre-existing session is still there', stillThere, `${untouched.length} checked`);
  } finally {
    if (created) {
      say(`cleanup: removing leftover session ${activeName}`);
      try { execFileSync('systemctl', ['--user', 'stop', unitName]); } catch { /* best effort */ }
      try { execFileSync(ZELLIJ, ['delete-session', '--force', activeName]); } catch { /* best effort */ }
    }
    for (const f of [
      path.join(MAXCLAUDE_CFG, 'sessions', `${name}.env`),
      path.join(MAXCLAUDE_CFG, `${name}.panes`),
      path.join(MAXCLAUDE_CFG, 'sessions', `${renamedName}.env`),
      path.join(MAXCLAUDE_CFG, `${renamedName}.panes`),
    ]) {
      try { fs.unlinkSync(f); } catch { /* not written */ }
    }
    for (const sessionName of [name, renamedName]) {
      fs.rmSync(path.join(process.env.MCW_FILES_ROOT || '', sessionName), { recursive: true, force: true });
    }
    try { fs.unlinkSync(secretFile); } catch { /* already gone */ }
    agent.kill('SIGTERM');
    hub.close();
    await sleep(1000);
  }

  say(`ALL ${results.length} CHECKS PASSED`);
}

main().then(() => process.exit(0)).catch((err) => {
  say(`TEST FAILED: ${err.message}`);
  if (err.wire) say(`error detail: ${JSON.stringify(err.wire).slice(0, 2000)}`);
  process.exit(1);
});
