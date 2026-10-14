import fs from 'node:fs';
import path from 'node:path';
import { config, webOrigin } from './config.js';
import { run, runOrThrow } from './exec.js';
import { RpcError } from './errors.js';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function webStatus() {
  const res = await run(config.zellijBin, ['web', '--status'], { timeout: 10000 });
  const text = `${res.stdout}${res.stderr}`.trim();
  return { online: /online/i.test(text), text: text.split('\n')[0] || '' };
}

export async function ensureWebServer() {
  let st = await webStatus();
  if (st.online) return st;
  log.info('starting zellij web server', { origin: webOrigin });
  const started = await run(config.zellijBin, ['web', '-d'], { timeout: 20000 });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    st = await webStatus();
    if (st.online) return st;
  }
  throw new RpcError('upstream_unavailable', 'zellij web did not come online', {
    stdout: started.stdout.slice(-2000),
    stderr: started.stderr.slice(-2000),
    status: st.text,
  });
}

function readTokenFile() {
  try {
    const raw = fs.readFileSync(config.tokenFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) return parsed;
  } catch {
    return null;
  }
  return null;
}

function writeTokenFile(rec) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.tokenFile, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(config.tokenFile, 0o600);
}

export async function mintToken() {
  const res = await runOrThrow(config.zellijBin, ['web', '--create-token'], { timeout: 15000 });
  const text = `${res.stdout}${res.stderr}`;
  const m = text.match(/(token_\d+)\s*:\s*([A-Za-z0-9-]+)/);
  if (!m) {
    throw new RpcError('internal', 'could not parse zellij web --create-token output', {
      stdout: res.stdout.slice(-2000),
      stderr: res.stderr.slice(-2000),
    });
  }
  const rec = { name: m[1], token: m[2], createdAt: Math.floor(Date.now() / 1000) };
  writeTokenFile(rec);
  log.info('minted zellij web token', { name: rec.name, file: config.tokenFile });
  return rec;
}

export async function ensureToken() {
  return readTokenFile() || mintToken();
}

let cookie = null;

export function currentCookie() {
  return cookie;
}

async function loginWith(token) {
  const res = await fetch(`${webOrigin}/command/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth_token: token, remember_me: true }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body };
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  for (const line of setCookie.filter(Boolean)) {
    const m = String(line).match(/session_token=([^;]+)/);
    if (m) return { ok: true, cookie: `session_token=${m[1]}` };
  }
  return { ok: false, status: res.status, body: `login succeeded without a session_token cookie: ${body}` };
}

export async function login({ force = false } = {}) {
  if (cookie && !force) return cookie;
  await ensureWebServer();
  let rec = await ensureToken();
  let attempt = await loginWith(rec.token);
  if (!attempt.ok) {
    log.warn('zellij web login rejected the stored token, minting a new one', { status: attempt.status });
    rec = await mintToken();
    attempt = await loginWith(rec.token);
  }
  if (!attempt.ok) {
    throw new RpcError('unauthorized', 'zellij web rejected the auth token', {
      status: attempt.status,
      body: String(attempt.body).slice(0, 2000),
    });
  }
  cookie = attempt.cookie;
  return cookie;
}

export function invalidateCookie() {
  cookie = null;
}

export function tokenName() {
  const rec = readTokenFile();
  return rec ? rec.name : null;
}

export function backupPath(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(path.dirname(file), `${path.basename(file)}.mcw-backup-${stamp}`);
}
