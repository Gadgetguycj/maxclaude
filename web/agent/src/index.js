#!/usr/bin/env node
import fs from 'node:fs';
import { config, webOrigin } from './config.js';
import { log } from './log.js';
import { ensureWebSharing } from './zellijconfig.js';
import { ensureWebServer, ensureToken, login, webStatus } from './zellijweb.js';
import { Tunnel } from './tunnel.js';
import { listSessions } from './sessions.js';

function readSecret() {
  let raw;
  try {
    raw = fs.readFileSync(config.secretFile, 'utf8');
  } catch (e) {
    log.error('tunnel secret is unreadable, refusing to start', { file: config.secretFile, error: String(e.message) });
    process.exit(1);
  }
  const secret = raw.replace(/\s+$/, '');
  if (!secret) {
    log.error('tunnel secret file is empty, refusing to start', { file: config.secretFile });
    process.exit(1);
  }
  const mode = fs.statSync(config.secretFile).mode & 0o777;
  if (mode & 0o077) {
    log.warn('tunnel secret is group or world readable', { file: config.secretFile, mode: mode.toString(8) });
  }
  return secret;
}

async function main() {
  log.info('mcw-agent starting', { version: config.version, hub: config.hubUrl, zellijWeb: webOrigin });
  const secret = readSecret();

  const sharing = await ensureWebSharing();
  log.info('zellij web_sharing', sharing);

  await ensureWebServer();
  await ensureToken();
  await login();
  log.info('zellij web ready', { origin: webOrigin });

  const tunnel = new Tunnel(secret);
  tunnel.start();

  let priorStatus = new Map();
  let priorConnectionEpoch = 0;
  let statusPolling = false;
  const statusWatch = setInterval(async () => {
    if (statusPolling) return;
    statusPolling = true;
    try {
      const { sessions } = await listSessions();
      const current = new Map(sessions.map((session) => [session.name, {
        state: session.activity,
        updatedAt: session.activityUpdatedAt,
        lastResponseAt: session.lastResponseAt,
        lastActivityAt: session.lastActivityAt,
      }]));
      const changed = [...current].some(([name, status]) => (
        priorStatus.get(name)?.state !== status.state
        || priorStatus.get(name)?.updatedAt !== status.updatedAt
        || priorStatus.get(name)?.lastResponseAt !== status.lastResponseAt
        || priorStatus.get(name)?.lastActivityAt !== status.lastActivityAt
      ))
        || [...priorStatus].some(([name]) => !current.has(name));
      if (changed || priorConnectionEpoch !== tunnel.connectionEpoch) {
        priorStatus = current;
        priorConnectionEpoch = tunnel.connectionEpoch;
        tunnel.sendEvent('sessions.status', { sessions: Object.fromEntries(current) });
      }
    } catch (err) {
      log.warn('session status poll failed', { error: String(err.message) });
    } finally {
      statusPolling = false;
    }
  }, config.statusWatchMs);

  const watch = setInterval(async () => {
    try {
      const st = await webStatus();
      if (st.online) return;
      log.warn('zellij web went offline, restarting it');
      await ensureWebServer();
      await login({ force: true });
      log.info('zellij web restarted');
    } catch (err) {
      log.error('zellij web could not be restarted', { error: String(err.message) });
      tunnel.sendJson({
        t: 'event',
        event: 'agent.degraded',
        data: { reason: 'zellij web is down', detail: { error: String(err.message) } },
      });
    }
  }, config.webWatchMs);

  const shutdown = (sig) => {
    log.info('shutting down', { signal: sig });
    clearInterval(watch);
    clearInterval(statusWatch);
    tunnel.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('mcw-agent failed to start', { error: String(err.message), detail: err.detail });
  process.exit(1);
});
