import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const STATUS_VALUES = new Set(['busy', 'idle']);
const transcriptCache = new Map();
let sessionEnvCache = { dir: null, expiresAt: 0, items: [] };

function readNulFile(file) {
  try {
    return fs.readFileSync(file).toString('utf8').split('\0');
  } catch {
    return [];
  }
}

function envValue(values, name) {
  const prefix = `${name}=`;
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function isClaudeCommand(values) {
  const executable = path.basename(values[0] || '');
  if (!/^claude(?:\.exe)?$/.test(executable)) return false;
  const args = values.slice(1).join(' ');
  return !/(?:^|\s)(?:bg-pty-host|bg-spare)(?:\s|$)|daemon run|--fork-session/.test(args);
}

export function readLiveClaudePanes(procRoot = '/proc') {
  const panes = new Map();
  let entries = [];
  try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { return panes; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const proc = path.join(procRoot, entry.name);
    const env = readNulFile(path.join(proc, 'environ'));
    const session = envValue(env, 'ZELLIJ_SESSION_NAME');
    const pane = envValue(env, 'ZELLIJ_PANE_ID') || `pid-${entry.name}`;
    const command = readNulFile(path.join(proc, 'cmdline'));
    if (!session || !isClaudeCommand(command)) continue;
    let startedAt = 0;
    try { startedAt = Math.floor(fs.statSync(proc).ctimeMs); } catch { /* process exited while sampled */ }
    const key = `${session}\0${pane}`;
    const previous = panes.get(key);
    const started = previous?.startedAt && startedAt
      ? Math.min(previous.startedAt, startedAt)
      : (previous?.startedAt || startedAt);
    panes.set(key, {
      session,
      pane,
      startedAt: started,
      pids: [...(previous?.pids || []), Number(entry.name)],
      commands: [...(previous?.commands || []), command],
      cwd: previous?.cwd || (() => { try { return fs.readlinkSync(path.join(proc, 'cwd')); } catch { return null; } })(),
    });
  }
  return panes;
}

function readPaneStatus(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.json`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!STATUS_VALUES.has(value.state) || !Number.isFinite(value.updatedAt)) return null;
    const pid = Number(value.pid);
    return {
      state: value.state,
      updatedAt: Math.floor(value.updatedAt),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      transcriptPath: typeof value.transcriptPath === 'string' ? value.transcriptPath : null,
    };
  } catch {
    return null;
  }
}

function readResponseStatus(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.response.json`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isFinite(value.lastResponseAt) || value.lastResponseAt <= 0) return null;
    return {
      lastResponseAt: Math.floor(value.lastResponseAt),
      transcriptPath: typeof value.transcriptPath === 'string' ? value.transcriptPath : null,
    };
  } catch {
    return null;
  }
}

function projectKey(cwd) {
  return String(cwd || '').replaceAll('/', '-');
}

function resumeSid(command) {
  for (let index = 0; index < command.length - 1; index += 1) {
    if (command[index] === '--resume' || command[index] === '--session-id') return command[index + 1];
  }
  return null;
}

function sessionEnvIds(sessionEnvDir) {
  if (sessionEnvCache.dir === sessionEnvDir && sessionEnvCache.expiresAt > Date.now()) {
    return sessionEnvCache.items;
  }
  try {
    const items = fs.readdirSync(sessionEnvDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .map((entry) => {
        const file = path.join(sessionEnvDir, entry.name);
        return { id: entry.name, at: fs.statSync(file).mtimeMs };
      });
    sessionEnvCache = { dir: sessionEnvDir, expiresAt: Date.now() + 60000, items };
    return items;
  } catch {
    return [];
  }
}

function transcriptForPane(pane, status, options, envIds) {
  if (status?.transcriptPath && fs.existsSync(status.transcriptPath)) return status.transcriptPath;
  const projectsDir = options.projectsDir || config.projectsDir;
  const cwd = pane.cwd;
  const commands = pane.commands || (pane.command ? [pane.command] : []);
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const explicit = resumeSid(commands[index]);
    if (!explicit) continue;
    if (path.isAbsolute(explicit) && explicit.endsWith('.jsonl') && fs.existsSync(explicit)) return explicit;
    if (cwd) {
      const file = path.join(projectsDir, projectKey(cwd), `${explicit}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  if (!cwd || !pane.startedAt) return null;
  let closest = null;
  for (const candidate of envIds) {
    const distance = Math.abs(candidate.at - pane.startedAt);
    if (distance <= 10000 && (!closest || distance < closest.distance)) closest = { ...candidate, distance };
  }
  if (!closest) return null;
  const file = path.join(projectsDir, projectKey(cwd), `${closest.id}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

function assistantTimestamp(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return 0; }
  const cached = transcriptCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.at;

  let at = 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let position = stat.size;
    let carry = '';
    const chunkSize = 64 * 1024;
    while (position > 0 && !at) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      fs.readSync(fd, buffer, 0, size, position);
      const parts = (buffer.toString('utf8') + carry).split('\n');
      carry = parts.shift() || '';
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const line = parts[index];
        if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) continue;
        try {
          const record = JSON.parse(line);
          if (record.type !== 'assistant') continue;
          const parsed = Date.parse(record.timestamp);
          if (Number.isFinite(parsed) && parsed > 0) { at = parsed; break; }
        } catch { /* an incomplete line is ignored */ }
      }
    }
    if (!at && carry) {
      try {
        const record = JSON.parse(carry);
        const parsed = record.type === 'assistant' ? Date.parse(record.timestamp) : 0;
        if (Number.isFinite(parsed) && parsed > 0) at = parsed;
      } catch { /* no complete assistant entry */ }
    }
  } catch {
    at = 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  transcriptCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, at });
  return at;
}

function lastResponseForPane(session, pane, status, options, envIds) {
  const transcriptPath = transcriptForPane(pane, status, options, envIds);
  const response = readResponseStatus(session, pane.pane, options.statusDir || config.statusDir);
  if (response) {
    if (response.transcriptPath && transcriptPath && response.transcriptPath === transcriptPath) return response.lastResponseAt;
    if (!response.transcriptPath && response.lastResponseAt >= (pane.startedAt || 0)) return response.lastResponseAt;
    if (!transcriptPath && response.lastResponseAt >= (pane.startedAt || 0)) return response.lastResponseAt;
  }
  return transcriptPath ? assistantTimestamp(transcriptPath) : 0;
}

export function aggregateSessionActivity(sessionNames, livePanes, options = {}) {
  const statusDir = options.statusDir || config.statusDir;
  const envIds = sessionEnvIds(options.sessionEnvDir || config.sessionEnvDir);
  const result = {};
  for (const name of sessionNames) {
    const panes = [...livePanes.values()].filter((pane) => pane.session === name);
    if (!panes.length) {
      result[name] = { state: 'absent', updatedAt: 0, lastResponseAt: 0 };
      continue;
    }
    const states = panes.map((pane) => {
      const raw = readPaneStatus(name, pane.pane, statusDir);
      const status = raw
        && (!pane.startedAt || raw.updatedAt >= pane.startedAt)
        ? raw
        : null;
      return { pane, status };
    });
    const lastResponseAt = Math.max(0, ...states.map(({ pane, status }) => (
      lastResponseForPane(name, pane, status, { ...options, statusDir }, envIds)
    )));
    const busy = states.filter(({ status }) => status?.state === 'busy');
    if (busy.length) {
      result[name] = {
        state: 'busy',
        updatedAt: Math.max(...busy.map(({ status }) => status.updatedAt)),
        lastResponseAt,
      };
      continue;
    }
    if (states.some(({ status }) => !status)) {
      result[name] = {
        state: 'unknown',
        updatedAt: Math.max(...states.map(({ pane }) => pane.startedAt || 0)),
        lastResponseAt,
      };
      continue;
    }
    result[name] = {
      state: 'idle',
      updatedAt: Math.max(...states.map(({ pane, status }) => status?.updatedAt || pane.startedAt || 0)),
      lastResponseAt,
    };
  }
  return result;
}

export function collectSessionActivity(sessionNames, options = {}) {
  return aggregateSessionActivity(sessionNames, readLiveClaudePanes(options.procRoot), options);
}
