import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, assertBootConfig } from './config.js';
import { openDb } from './db.js';
import { authenticate, purgeExpiredSessions, seedOperatorPassword, cookieSecret } from './auth.js';
import { Tunnel } from './tunnel.js';
import { createApi } from './api.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

function log(scope, message, detail) {
  const line = { at: new Date().toISOString(), scope, message };
  if (detail) line.detail = detail;
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main() {
  assertBootConfig();
  openDb();
  const seeded = await seedOperatorPassword();
  cookieSecret();
  log('boot', `operator password ${seeded}`);

  const tunnel = new Tunnel(config.agentSecret);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, agent: tunnel.connected });
  });

  app.use('/api', createApi(tunnel));

  const appShell = (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(config.publicDir, 'index.html'));
  };

  app.get('/', appShell);
  app.get('/index.html', appShell);
  // Revalidate on every load. A rollout drops every terminal socket and each warm frame reloads
  // at once, so a cached client from the previous build must not survive into that reload.
  app.use(express.static(config.publicDir, { index: false, maxAge: 0 }));

  // The zellij web client reads the session name out of the browser path, so the
  // iframe URL and the upstream path must be identical. /t/<name> is a courtesy
  // redirect onto that canonical path.
  app.get(/^\/t\/(.+)$/, (req, res) => {
    res.redirect(302, `/${req.params[0]}`);
  });

  app.use((req, res) => {
    if (!authenticate(req)) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    tunnel.proxyHttp(req, res, req.originalUrl);
  });

  const server = http.createServer(app);
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 120000;

  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        const remote = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        tunnel.accept(ws, String(remote || 'unknown'));
      });
      return;
    }

    if (!authenticate(req)) {
      log('ws', 'upgrade refused, no session cookie', { path: pathname });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    clientWss.handleUpgrade(req, socket, head, (ws) => {
      tunnel.proxyWebSocket(ws, req.url);
    });
  });

  // Traefik and any intermediary see traffic on an otherwise idle terminal socket.
  const clientKeepalive = setInterval(() => {
    for (const ws of clientWss.clients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, config.clientPingMs);
  clientKeepalive.unref();

  const purge = setInterval(purgeExpiredSessions, 60 * 60 * 1000);
  purge.unref();

  server.listen(config.port, config.host, () => {
    log('boot', `listening on ${config.host}:${config.port}`, { dataDir: config.dataDir });
  });

  const shutdown = (signal) => {
    log('boot', `shutting down on ${signal}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log('boot', 'startup failed', { message: err.message, stack: err.stack });
  process.exit(1);
});
