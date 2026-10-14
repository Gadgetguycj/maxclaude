import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { config } from './config.js';
import { getDb, getSetting, setSetting } from './db.js';

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
};

const KEY_HASH = 'operator_password_hash';
const KEY_COOKIE_SECRET = 'cookie_secret';

export async function seedOperatorPassword() {
  const supplied = config.operatorPassword;
  const existing = getSetting(KEY_HASH);

  if (!supplied) {
    if (!existing) {
      throw new Error('OPERATOR_PASSWORD is required on first boot to seed the operator password');
    }
    return 'kept';
  }

  if (existing && await argonVerify(existing, supplied)) return 'kept';

  const digest = await argonHash(supplied, ARGON_OPTIONS);
  setSetting(KEY_HASH, digest);
  return existing ? 'rotated' : 'seeded';
}

export function cookieSecret() {
  let secret = getSetting(KEY_COOKIE_SECRET);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    setSetting(KEY_COOKIE_SECRET, secret);
  }
  return secret;
}

export async function verifyPassword(password) {
  const digest = getSetting(KEY_HASH);
  if (!digest) return false;
  try {
    return await argonVerify(digest, password);
  } catch {
    return false;
  }
}

function sign(value) {
  return crypto.createHmac('sha256', cookieSecret()).update(value).digest('base64url');
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createBrowserSession(ip, userAgent) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO browser_sessions (id, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, now, now + config.sessionTtlMs, now, ip || null, (userAgent || '').slice(0, 300));
  return `${id}.${sign(id)}`;
}

export function revokeBrowserSession(token) {
  const id = parseToken(token);
  if (!id) return;
  getDb().prepare('DELETE FROM browser_sessions WHERE id = ?').run(id);
}

function parseToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqual(sign(id), mac)) return null;
  return id;
}

export function validateToken(token) {
  const id = parseToken(token);
  if (!id) return null;
  const row = getDb().prepare('SELECT * FROM browser_sessions WHERE id = ?').get(id);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    getDb().prepare('DELETE FROM browser_sessions WHERE id = ?').run(id);
    return null;
  }
  if (now - row.last_seen > 60000) {
    getDb().prepare('UPDATE browser_sessions SET last_seen = ? WHERE id = ?').run(now, id);
  }
  return row;
}

export function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM browser_sessions WHERE expires_at <= ?').run(Date.now());
  getDb().prepare('DELETE FROM login_attempts WHERE ts < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function lockoutState(ip) {
  const row = getDb().prepare('SELECT * FROM lockouts WHERE ip = ?').get(ip);
  if (!row) return null;
  if (row.until <= Date.now()) return null;
  return row;
}

export function recordAttempt(ip, ok, detail) {
  getDb()
    .prepare('INSERT INTO login_attempts (ts, ip, ok, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), ip, ok ? 1 : 0, detail || null);
}

export function recentFailures(ip) {
  const since = Date.now() - config.loginWindowMs;
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND ts >= ?')
    .get(ip, since);
  return row.n;
}

export function applyLockout(ip) {
  const row = getDb().prepare('SELECT * FROM lockouts WHERE ip = ?').get(ip);
  const strikes = (row ? row.strikes : 0) + 1;
  const duration = Math.min(config.lockoutBaseMs * 2 ** (strikes - 1), config.lockoutMaxMs);
  const until = Date.now() + duration;
  getDb()
    .prepare(
      'INSERT INTO lockouts (ip, until, strikes) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET until = excluded.until, strikes = excluded.strikes'
    )
    .run(ip, until, strikes);
  return { until, strikes };
}

export function clearLockout(ip) {
  getDb().prepare('DELETE FROM lockouts WHERE ip = ?').run(ip);
  getDb().prepare('DELETE FROM login_attempts WHERE ip = ? AND ok = 0').run(ip);
}

export function sessionCookieHeader(token, maxAgeMs) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader() {
  const parts = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function authenticate(req) {
  const token = readCookie(req.headers.cookie, config.cookieName);
  if (!token) return null;
  return validateToken(token);
}

export function requireAuth(req, res, next) {
  const session = authenticate(req);
  if (!session) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.operatorSession = session;
  next();
}
