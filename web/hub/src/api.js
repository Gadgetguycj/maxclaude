import express from 'express';
import { config } from './config.js';
import {
  applyLockout,
  clearCookieHeader,
  clearLockout,
  clientIp,
  createBrowserSession,
  lockoutState,
  readCookie,
  recentFailures,
  recordAttempt,
  requireAuth,
  revokeBrowserSession,
  sessionCookieHeader,
  validateToken,
  verifyPassword
} from './auth.js';
import { TunnelError } from './tunnel.js';
import {
  TreeError,
  cleanPanes,
  cleanResumeSid,
  cleanSessionName,
  cleanWorkdir,
  createFolder,
  createSessionLeaf,
  deleteNodeRow,
  findSessionLeaf,
  getNode,
  listNodes,
  renameSessionLeaf,
  reparentChildren,
  subtree,
  updateNode
} from './tree.js';
import { getDb } from './db.js';

// Session names that would shadow an app route or a zellij asset path.
const RESERVED_NAMES = new Set([
  'api',
  'agent',
  'assets',
  'ws',
  'command',
  'session',
  'info',
  'healthz',
  'index.html',
  'app.js',
  'styles.css',
  'favicon.ico'
]);
const RECENT_LIMITS = new Set([0, 3, 5, 10, 15]);
const RECENT_LIMIT_KEY = 'recent_limit';
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function recentLimit() {
  const raw = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(RECENT_LIMIT_KEY)?.value;
  const value = Number.parseInt(raw, 10);
  return RECENT_LIMITS.has(value) ? value : 5;
}

function setRecentLimit(value) {
  if (!RECENT_LIMITS.has(value)) throw new TreeError(400, 'bad_recent_limit', 'recent limit must be Off, 3, 5, 10, or 15');
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(RECENT_LIMIT_KEY, String(value));
}

function recentSessions(sessions, limit, sessionStatus = {}) {
  if (!limit) return [];
  return (sessions || [])
    .filter((session) => session?.name && !session.exited)
    .map((session) => {
      const status = sessionStatus[session.name] || {};
      const statusActivity = Object.hasOwn(status, 'lastActivityAt')
        ? Number(status.lastActivityAt) || 0
        : (Number(status.updatedAt) || Number(status.lastResponseAt) || 0);
      const sessionActivity = Object.hasOwn(session, 'lastActivityAt')
        ? Number(session.lastActivityAt) || 0
        : (Number(session.activityUpdatedAt) || Number(session.lastResponseAt) || 0);
      const lastActivityAt = Object.hasOwn(sessionStatus, session.name)
        ? Math.max(0, statusActivity)
        : Math.max(0, sessionActivity);
      return {
        session_name: session.name,
        last_activity_at: lastActivityAt
      };
    })
    .sort((left, right) => (
      right.last_activity_at - left.last_activity_at
      || left.session_name.localeCompare(right.session_name)
    ))
    .slice(0, limit)
    .map(({ session_name, last_activity_at }) => ({ session_name, last_activity_at }));
}

function sessionsWithOriginalCreationTimes(sessions) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO session_origins (session_name, original_created_at) VALUES (?, ?)
    ON CONFLICT(session_name) DO UPDATE SET
      original_created_at = MIN(session_origins.original_created_at, excluded.original_created_at)
  `);
  const find = db.prepare('SELECT original_created_at FROM session_origins WHERE session_name = ?');
  const remember = db.transaction((rows) => {
    for (const session of rows) {
      const createdAt = Number(session?.createdAt ?? session?.created_at);
      if (session?.name && Number.isFinite(createdAt) && createdAt > 0) upsert.run(session.name, Math.floor(createdAt));
    }
  });
  remember(sessions);
  return sessions.map((session) => {
    const originalCreatedAt = find.get(session.name)?.original_created_at;
    return {
      ...session,
      originalCreatedAt: Number.isFinite(originalCreatedAt) ? originalCreatedAt : 0,
    };
  });
}

function carrySessionOrigin(oldName, newName) {
  const row = getDb().prepare('SELECT original_created_at FROM session_origins WHERE session_name = ?').get(oldName);
  if (!row) return;
  getDb().prepare(`
    INSERT INTO session_origins (session_name, original_created_at) VALUES (?, ?)
    ON CONFLICT(session_name) DO UPDATE SET
      original_created_at = MIN(session_origins.original_created_at, excluded.original_created_at)
  `).run(newName, row.original_created_at);
}

function log(scope, message, detail) {
  const line = { at: new Date().toISOString(), scope, message };
  if (detail) line.detail = detail;
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function recordTransfer(session, filePath, size, direction) {
  const createdAt = Date.now();
  const info = getDb().prepare(`
    INSERT INTO file_transfers (session_name, path, size, direction, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(session, filePath, size, direction, createdAt);
  log('transfer', 'file transfer complete', {
    session, path: filePath, size, direction,
  });
  return { id: Number(info.lastInsertRowid), session_name: session, path: filePath, size, direction, created_at: createdAt };
}

function transferRows(session) {
  return getDb().prepare(`
    SELECT id, session_name, path, size, direction, created_at
    FROM file_transfers WHERE session_name = ?
    ORDER BY created_at DESC, id DESC LIMIT 200
  `).all(session);
}

function fail(res, err) {
  if (err instanceof TreeError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err instanceof TunnelError) {
    return res.status(err.httpStatus).json({ error: err.code, message: err.message, detail: err.detail });
  }
  log('api', 'unhandled error', { message: err.message, stack: err.stack });
  return res.status(500).json({ error: 'internal', message: 'unexpected server error' });
}

export function createApi(tunnel) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  let sessionsInFlight = null;
  const eventClients = new Set();
  const broadcast = (event, data) => {
    const wire = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of eventClients) {
      if (res.destroyed) eventClients.delete(res);
      else res.write(wire);
    }
  };
  const eventHeartbeat = setInterval(() => {
    for (const res of eventClients) {
      if (res.destroyed) eventClients.delete(res);
      else res.write(': keepalive\n\n');
    }
  }, 15000);
  eventHeartbeat.unref();
  tunnel.on('event', (event) => {
    if (event.event === 'sessions.status') broadcast('sessions.status', tunnel.status().sessionStatus);
  });
  tunnel.on('connected', () => broadcast('agent', tunnel.status()));
  tunnel.on('disconnected', () => broadcast('agent', tunnel.status()));

  function liveSessions() {
    if (!tunnel.connected) return Promise.resolve(null);
    if (sessionsInFlight) return sessionsInFlight;
    sessionsInFlight = tunnel
      .rpc('sessions.list')
      .then((result) => sessionsWithOriginalCreationTimes(Array.isArray(result?.sessions) ? result.sessions : []))
      .finally(() => {
        sessionsInFlight = null;
      });
    return sessionsInFlight;
  }

  router.post('/login', async (req, res) => {
    const ip = clientIp(req);
    const locked = lockoutState(ip);
    if (locked) {
      recordAttempt(ip, false, 'locked_out');
      log('auth', 'login refused, locked out', { ip, until: locked.until });
      return res
        .status(429)
        .json({ error: 'locked_out', retry_after_s: Math.ceil((locked.until - Date.now()) / 1000) });
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) {
      recordAttempt(ip, false, 'empty');
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const ok = await verifyPassword(password);
    recordAttempt(ip, ok, ok ? 'ok' : 'bad_password');

    if (!ok) {
      const failures = recentFailures(ip);
      log('auth', 'login failed', { ip, failures });
      if (failures >= config.loginMaxFailures) {
        const { until } = applyLockout(ip);
        log('auth', 'lockout applied', { ip, until });
        return res.status(429).json({ error: 'locked_out', retry_after_s: Math.ceil((until - Date.now()) / 1000) });
      }
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    clearLockout(ip);
    const token = createBrowserSession(ip, req.headers['user-agent']);
    res.setHeader('Set-Cookie', sessionCookieHeader(token, config.sessionTtlMs));
    log('auth', 'login ok', { ip });
    return res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req.headers.cookie, config.cookieName);
    if (token) revokeBrowserSession(token);
    res.setHeader('Set-Cookie', clearCookieHeader());
    return res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const token = readCookie(req.headers.cookie, config.cookieName);
    if (!token || !validateToken(token)) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true });
  });

  router.use(requireAuth);

  router.get('/state', async (req, res) => {
    const status = tunnel.status();
    let sessions = null;
    let sessionsError = null;
    try {
      sessions = await liveSessions();
    } catch (err) {
      sessions = null;
      sessionsError = { error: err.code || 'internal', message: err.message };
      log('api', 'sessions.list failed', sessionsError);
    }
    return res.json({
      agent: {
        connected: status.connected && !sessionsError,
        since: status.since,
        host: status.info?.host || null,
        webSharing: status.info?.webSharing || null,
        degraded: status.degraded || null,
        error: sessionsError
      },
      tree: listNodes().map(publicNode),
      sessions,
      session_status: status.sessionStatus,
      recents: recentSessions(sessions, recentLimit(), status.sessionStatus),
      recent_limit: recentLimit()
    });
  });

  router.get('/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.flushHeaders();
    res.write(`event: state\ndata: ${JSON.stringify({ session_status: tunnel.status().sessionStatus })}\n\n`);
    eventClients.add(res);
    req.on('close', () => eventClients.delete(res));
  });

  router.post('/sessions/:name/open', async (req, res) => {
    try {
      const name = cleanSessionName(req.params.name);
      let sessions = await liveSessions();
      if (sessions === null) throw new TunnelError('agent_disconnected', 'the agent is not connected');
      const target = sessions.find((session) => session.name === name && !session.exited);
      if (!target) {
        throw new TreeError(404, 'not_found', `session ${name} is not running`);
      }
      const lease = await tunnel.rpc('sessions.reserveViewer', { name });
      let wake = null;
      try {
        if (target.sleeping) {
          wake = await tunnel.rpc('sessions.wake', { name });
          sessionsInFlight = null;
          sessions = await liveSessions();
        }
      } catch (err) {
        await tunnel.rpc('sessions.releaseViewer', { leaseId: lease.leaseId }).catch(() => {});
        throw err;
      }
      return res.json({
        ok: true,
        session_name: name,
        wake,
        recents: recentSessions(sessions, recentLimit(), tunnel.status().sessionStatus)
      });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/sessions/hibernate-preview', async (req, res) => {
    try {
      const automatic = req.query.automatic === '1';
      return res.json(await tunnel.rpc('sessions.hibernateCandidates', { automatic }));
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/sessions/:name/hibernate', async (req, res) => {
    try {
      const name = cleanSessionName(req.params.name);
      const result = await tunnel.rpc('sessions.hibernate', { name, automatic: false });
      sessionsInFlight = null;
      return res.json(result);
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/sessions/hibernate-idle', async (req, res) => {
    try {
      const names = Array.isArray(req.body?.names) ? req.body.names : null;
      if (!names || !names.length || names.some((name) => typeof name !== 'string')) {
        throw new TreeError(400, 'bad_request', 'names must contain the sessions displayed in the confirmation');
      }
      const results = [];
      const skipped = [];
      for (const name of [...new Set(names)]) {
        try {
          results.push(await tunnel.rpc('sessions.hibernate', { name, automatic: false }));
        } catch (err) {
          skipped.push({ name, reason: err.message });
        }
      }
      sessionsInFlight = null;
      return res.json({ hibernated: results, skipped });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.put('/preferences/recent-limit', async (req, res) => {
    try {
      const value = Number(req.body?.recent_limit);
      setRecentLimit(value);
      const sessions = await liveSessions();
      return res.json({
        recent_limit: value,
        recents: recentSessions(sessions, value, tunnel.status().sessionStatus)
      });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/transcripts', async (req, res) => {
    try {
      const result = await tunnel.rpc('transcripts.list', { limit: 100 });
      const transcripts = (result?.transcripts || []).map((t) => ({
        sid: t.uuid,
        title: t.title,
        mtime: typeof t.mtime === 'number' ? t.mtime * 1000 : null,
        size: t.size ?? null
      }));
      return res.json({ transcripts });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/sessions/:name/uploads', async (req, res) => {
    try {
      const session = cleanSessionName(req.params.name);
      const batch = typeof req.query.batch === 'string' ? req.query.batch : '';
      const uploadId = typeof req.query.upload_id === 'string' ? req.query.upload_id : `${batch}_single`;
      const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
      const size = Number(req.query.size);
      if (!Number.isInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES) {
        throw new TreeError(400, 'bad_request', 'a single upload may not exceed 2 GB');
      }
      const chunkSize = req.query.chunk_size === undefined ? size : Number(req.query.chunk_size);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      const final = req.query.final === undefined ? true : req.query.final === '1';
      if (!Number.isInteger(chunkSize) || chunkSize < 0 || chunkSize > size
        || !Number.isInteger(offset) || offset < 0 || offset + chunkSize > size) {
        throw new TreeError(400, 'bad_request', 'upload chunk range is invalid');
      }
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength !== chunkSize) {
        throw new TreeError(400, 'bad_request', 'content length does not match the declared upload size');
      }
      const result = await tunnel.upload(req, {
        session, batch, uploadId, path: relativePath, size: chunkSize, totalSize: size, offset, final,
      });
      const complete = result.complete !== false;
      const transfer = complete ? recordTransfer(session, result.path, result.size, 'upload') : null;
      return res.json({
        path: result.path, batch_root: result.batchRoot, size: result.size,
        complete, transfer,
      });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/files/stat', async (req, res) => {
    try {
      const session = cleanSessionName(req.body?.session);
      const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
      const result = await tunnel.rpc('files.stat', { session, paths });
      return res.json(result);
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/sessions/:name/files', (req, res) => {
    try {
      const session = cleanSessionName(req.params.name);
      return res.json({ transfers: transferRows(session) });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/files/download', async (req, res) => {
    try {
      const session = cleanSessionName(req.query.session);
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const result = await tunnel.download(req, res, { session, path: filePath });
      recordTransfer(session, result.path, result.size, 'download');
    } catch (err) {
      if (!res.headersSent) return fail(res, err);
      if (!res.destroyed) res.destroy(err);
    }
  });

  router.post('/folders', (req, res) => {
    try {
      const node = createFolder(req.body?.name, req.body?.parent_id ?? null);
      return res.json({ node: publicNode(node) });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.patch('/nodes/:id', (req, res) => {
    try {
      const patch = {};
      if (req.body?.name !== undefined) patch.name = req.body.name;
      if (req.body?.parent_id !== undefined) patch.parent_id = req.body.parent_id;
      if (req.body?.position !== undefined) patch.position = req.body.position;
      const node = updateNode(req.params.id, patch);
      return res.json({ node: publicNode(node) });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.delete('/folders/:id', async (req, res) => {
    try {
      const node = getNode(req.params.id);
      if (!node) throw new TreeError(404, 'not_found', 'folder does not exist');
      if (node.kind !== 'folder') throw new TreeError(400, 'not_a_folder', 'that node is not a folder');

      const mode = req.query.mode;
      if (mode !== 'move_up' && mode !== 'delete_sessions') {
        throw new TreeError(400, 'bad_mode', 'mode must be move_up or delete_sessions');
      }

      if (mode === 'move_up') {
        reparentChildren(node.id, node.parent_id);
        deleteNodeRow(node.id);
        log('tree', 'folder deleted, children moved up', { id: node.id, name: node.name });
        return res.json({ ok: true });
      }

      const leaves = subtree(node.id).filter((n) => n.kind === 'session');
      if (leaves.length && !tunnel.connected) {
        throw new TunnelError('agent_disconnected', 'the agent is not connected, sessions cannot be destroyed');
      }
      for (const leaf of leaves) {
        await tunnel.rpc('sessions.delete', { name: leaf.session_name });
        log('tree', 'session destroyed with folder', { session: leaf.session_name });
      }
      deleteNodeRow(node.id);
      return res.json({ ok: true, destroyed: leaves.map((l) => l.session_name) });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/sessions', async (req, res) => {
    try {
      const name = cleanSessionName(req.body?.name);
      if (RESERVED_NAMES.has(name.toLowerCase())) {
        throw new TreeError(400, 'reserved_name', `${name} is reserved by the app and cannot be a session name`);
      }
      const panes = req.body?.panes === undefined || req.body?.panes === null ? 1 : cleanPanes(req.body.panes);
      const workdir = cleanWorkdir(req.body?.workdir);
      const resumeSid = cleanResumeSid(req.body?.resume_sid);

      const result = await tunnel.rpc('sessions.create', {
        name,
        panes,
        workdir,
        resumeSid,
        org: null,
        settings: null,
        appendPrompt: null,
        extraArgs: null
      });
      log('tree', 'session created', { name, panes, workdir, resumeSid, unit: result?.unit });

      const existing = findSessionLeaf(name);
      if (existing) {
        getDb()
          .prepare('UPDATE nodes SET panes = ?, workdir = ?, resume_sid = ? WHERE id = ?')
          .run(panes, workdir, resumeSid, existing.id);
        return res.json({ node: publicNode(getNode(existing.id)) });
      }

      const node = createSessionLeaf({
        sessionName: name,
        panes,
        workdir,
        resumeSid,
        parentId: req.body?.parent_id ?? null
      });
      return res.json({ node: publicNode(node) });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/sessions/rename', async (req, res) => {
    try {
      const oldName = cleanSessionName(req.body?.old_name);
      const newName = cleanSessionName(req.body?.new_name);
      if (RESERVED_NAMES.has(newName.toLowerCase())) {
        throw new TreeError(400, 'reserved_name', `${newName} is reserved by the app and cannot be a session name`);
      }
      if (oldName === newName) {
        return res.json({ node: publicNode(findSessionLeaf(oldName)), old_name: oldName, new_name: newName });
      }
      if (findSessionLeaf(newName)) {
        throw new TreeError(409, 'session_exists', `a leaf for session ${newName} already exists`);
      }

      const leaf = findSessionLeaf(oldName);
      const result = await tunnel.rpc('sessions.rename', { oldName, newName }, 120000);
      let node = null;
      try {
        node = getDb().transaction(() => {
          const updated = leaf ? renameSessionLeaf(leaf.id, newName) : null;
          carrySessionOrigin(oldName, newName);
          return updated;
        })();
      } catch (dbError) {
        try {
          await tunnel.rpc('sessions.rename', { oldName: newName, newName: oldName }, 120000);
        } catch (rollbackError) {
          log('tree', 'session rename database rollback failed', {
            oldName,
            newName,
            databaseError: dbError.message,
            rollbackError: rollbackError.message,
          });
        }
        throw dbError;
      }
      log('tree', 'session renamed', {
        oldName,
        newName,
        oldUnit: result?.oldUnit,
        newUnit: result?.newUnit,
      });
      return res.json({
        node: publicNode(node),
        old_name: oldName,
        new_name: newName,
        claude_reports: result?.claudeReports || [],
      });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.delete('/sessions/:id', async (req, res) => {
    try {
      const node = getNode(req.params.id);
      if (!node) throw new TreeError(404, 'not_found', 'leaf does not exist');
      if (node.kind !== 'session') throw new TreeError(400, 'not_a_session', 'that node is not a session');
      await tunnel.rpc('sessions.delete', { name: node.session_name });
      deleteNodeRow(node.id);
      log('tree', 'session deleted', { name: node.session_name });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/adopt', async (req, res) => {
    try {
      const name = cleanSessionName(req.body?.session_name);
      if (findSessionLeaf(name)) throw new TreeError(409, 'session_exists', 'that session already has a leaf');
      const sessions = await liveSessions();
      if (sessions === null) {
        throw new TunnelError('agent_disconnected', 'the agent is not connected');
      }
      if (!sessions.some((s) => s.name === name)) {
        throw new TreeError(404, 'not_found', `${name} is not in the live session list`);
      }
      const node = createSessionLeaf({
        sessionName: name,
        panes: null,
        workdir: null,
        resumeSid: null,
        parentId: req.body?.parent_id ?? null
      });
      log('tree', 'session filed', { name, parent: node.parent_id });
      return res.json({ node: publicNode(node) });
    } catch (err) {
      return fail(res, err);
    }
  });

  return router;
}

function publicNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    parent_id: node.parent_id,
    kind: node.kind,
    name: node.name,
    position: node.position,
    session_name: node.session_name,
    panes: node.panes,
    workdir: node.workdir,
    resume_sid: node.resume_sid
  };
}
