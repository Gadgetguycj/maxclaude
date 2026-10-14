import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} is not an integer: ${raw}`);
  return n;
}

function trustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^[0-9]+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

export const config = {
  port: int('PORT', 8080),
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR || '/data',
  publicDir: path.join(here, '..', 'public'),
  trustProxy: trustProxy(),

  operatorPassword: process.env.OPERATOR_PASSWORD || '',
  agentSecret: process.env.AGENT_SECRET || '',

  cookieName: 'mcw_session',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  sessionTtlMs: int('SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,

  loginWindowMs: int('LOGIN_WINDOW_S', 900) * 1000,
  loginMaxFailures: int('LOGIN_MAX_FAILURES', 8),
  lockoutBaseMs: int('LOCKOUT_BASE_S', 900) * 1000,
  lockoutMaxMs: int('LOCKOUT_MAX_S', 21600) * 1000,

  agentPingMs: int('AGENT_PING_MS', 20000),
  agentRpcTimeoutMs: int('AGENT_RPC_TIMEOUT_MS', 20000),
  clientPingMs: int('CLIENT_PING_MS', 25000)
};

export function assertBootConfig() {
  const missing = [];
  if (!config.agentSecret) missing.push('AGENT_SECRET');
  if (missing.length) {
    throw new Error(`missing required environment: ${missing.join(', ')}`);
  }
}
