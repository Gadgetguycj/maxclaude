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

function descendsFrom(pid, ancestors, procRoot) {
  let current = Number(pid);
  for (let depth = 0; current > 1 && depth < 64; depth += 1) {
    let parent = 0;
    try {
      const match = fs.readFileSync(path.join(procRoot, String(current), 'status'), 'utf8').match(/^PPid:\s+(\d+)/m);
      parent = Number(match?.[1] || 0);
    } catch { return false; }
    if (ancestors.has(parent)) return true;
    current = parent;
  }
  return false;
}

function readProcessSnapshot(procRoot = '/proc', now = Date.now(), minBackgroundAgeMs = 2000) {
  const claudePanes = new Map();
  const backgroundRoots = new Map();
  const backgroundOutput = new Map();
  const backgroundPanes = new Map();
  const sessionTagged = [];
  let entries = [];
  try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { return { claudePanes, backgroundPanes }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const proc = path.join(procRoot, entry.name);
    const env = readNulFile(path.join(proc, 'environ'));
    const session = envValue(env, 'ZELLIJ_SESSION_NAME');
    const pane = envValue(env, 'ZELLIJ_PANE_ID') || `pid-${entry.name}`;
    const command = readNulFile(path.join(proc, 'cmdline'));
    if (!session || !command[0]) continue;
    let startedAt = 0;
    try { startedAt = Math.floor(fs.statSync(proc).ctimeMs); } catch { /* process exited while sampled */ }
    const key = `${session}\0${pane}`;
    let ppid = 0;
    try {
      const match = fs.readFileSync(path.join(proc, 'status'), 'utf8').match(/^PPid:\s+(\d+)/m);
      ppid = Number(match?.[1] || 0);
    } catch { /* process exited while sampled */ }
    sessionTagged.push({ pid: Number(entry.name), ppid, session, pane, command, startedAt });
    if (isClaudeCommand(command)) {
      const previous = claudePanes.get(key);
      const started = previous?.startedAt && startedAt
        ? Math.min(previous.startedAt, startedAt)
        : (previous?.startedAt || startedAt);
      claudePanes.set(key, {
        session,
        pane,
        startedAt: started,
        pids: [...(previous?.pids || []), Number(entry.name)],
        commands: [...(previous?.commands || []), command],
        cwd: previous?.cwd || (() => { try { return fs.readlinkSync(path.join(proc, 'cwd')); } catch { return null; } })(),
      });
      continue;
    }
    const sessionId = envValue(env, 'CLAUDE_CODE_SESSION_ID');
    if (!envValue(env, 'ZELLIJ_PANE_ID') || !sessionId) continue;
    const backgroundKey = `${key}\0${sessionId}`;
    for (const fd of ['1', '2']) {
      try {
        const stat = fs.statSync(path.join(proc, 'fd', fd));
        if (stat.isFile()) backgroundOutput.set(backgroundKey, Math.max(backgroundOutput.get(backgroundKey) || 0, Math.floor(stat.mtimeMs)));
      } catch { /* process exited or output is not statable */ }
    }
    const executable = path.basename(command[0]);
    const commandLine = command.join(' ');
    if (!/^(?:ba|z)?sh$/.test(executable) || !commandLine.includes('/.claude/shell-snapshots/')) continue;
    if (now - startedAt < minBackgroundAgeMs) continue;
    const previous = backgroundRoots.get(backgroundKey);
    backgroundRoots.set(backgroundKey, {
      session,
      pane,
      startedAt: Math.min(previous?.startedAt || startedAt, startedAt),
      pids: [...(previous?.pids || []), Number(entry.name)],
      sessionId,
    });
  }
  for (const [backgroundKey, root] of backgroundRoots) {
    const key = `${root.session}\0${root.pane}`;
    const mainPids = new Set(claudePanes.get(key)?.pids || []);
    if (!mainPids.size || !root.pids.some((pid) => descendsFrom(pid, mainPids, procRoot))) continue;
    const previous = backgroundPanes.get(key);
    const activityAt = Math.max(root.startedAt, backgroundOutput.get(backgroundKey) || 0);
    backgroundPanes.set(key, {
      session: root.session,
      pane: root.pane,
      startedAt: Math.min(previous?.startedAt || root.startedAt, root.startedAt),
      activityAt: Math.max(previous?.activityAt || 0, activityAt),
      pids: [...(previous?.pids || []), ...root.pids],
      sessionIds: [...new Set([...(previous?.sessionIds || []), root.sessionId])],
    });
  }
  const claudePidsBySession = new Map();
  for (const pane of claudePanes.values()) {
    if (!claudePidsBySession.has(pane.session)) claudePidsBySession.set(pane.session, new Set());
    for (const pid of pane.pids) claudePidsBySession.get(pane.session).add(pid);
  }
  const detachedCandidates = sessionTagged.filter((process) => {
    const executable = path.basename(process.command[0]);
    if (/^zellij(?:\.exe)?$/.test(executable) || isClaudeCommand(process.command)) return false;
    const claudePids = claudePidsBySession.get(process.session);
    return !claudePids?.size || !descendsFrom(process.pid, claudePids, procRoot);
  });
  const detachedIds = new Set(detachedCandidates.map((process) => process.pid));
  const detachedSessions = new Map();
  for (const process of detachedCandidates) {
    if (detachedIds.has(process.ppid)) continue;
    const prior = detachedSessions.get(process.session) || { pids: [], startedAt: 0 };
    prior.pids.push(process.pid);
    prior.startedAt = Math.max(prior.startedAt, process.startedAt || 0);
    detachedSessions.set(process.session, prior);
  }
  return { claudePanes, backgroundPanes, detachedSessions };
}

export function readLiveClaudePanes(procRoot = '/proc') {
  return readProcessSnapshot(procRoot).claudePanes;
}

export function readSessionProcessSnapshot(procRoot = '/proc', now = Date.now(), minBackgroundAgeMs = 2000) {
  return readProcessSnapshot(procRoot, now, minBackgroundAgeMs);
}

export function readLiveBackgroundPanes(procRoot = '/proc', now = Date.now(), minAgeMs = 2000) {
  return readProcessSnapshot(procRoot, now, minAgeMs).backgroundPanes;
}

export function readDetachedSessionTasks(procRoot = '/proc') {
  return readProcessSnapshot(procRoot).detachedSessions;
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

function readBackgroundStatus(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.background.json`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isFinite(value.updatedAt) || !Number.isInteger(value.taskCount) || value.taskCount < 0) return null;
    return {
      updatedAt: Math.floor(value.updatedAt),
      taskCount: value.taskCount,
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

function transcriptTimestamps(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { assistantAt: 0, activityAt: 0 }; }
  const cached = transcriptCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;

  let assistantAt = 0;
  let activityAt = 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let position = stat.size;
    let carry = '';
    const chunkSize = 64 * 1024;
    while (position > 0 && (!assistantAt || !activityAt)) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      fs.readSync(fd, buffer, 0, size, position);
      const parts = (buffer.toString('utf8') + carry).split('\n');
      carry = parts.shift() || '';
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const line = parts[index];
        if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')
          && !line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
        try {
          const record = JSON.parse(line);
          if (record.type !== 'assistant' && record.type !== 'user') continue;
          const parsed = Date.parse(record.timestamp);
          if (!Number.isFinite(parsed) || parsed <= 0) continue;
          if (!activityAt) activityAt = parsed;
          if (!assistantAt && record.type === 'assistant') assistantAt = parsed;
          if (assistantAt && activityAt) break;
        } catch { /* an incomplete line is ignored */ }
      }
    }
    if ((!assistantAt || !activityAt) && carry) {
      try {
        const record = JSON.parse(carry);
        if (record.type === 'assistant' || record.type === 'user') {
          const parsed = Date.parse(record.timestamp);
          if (Number.isFinite(parsed) && parsed > 0) {
            if (!activityAt) activityAt = parsed;
            if (!assistantAt && record.type === 'assistant') assistantAt = parsed;
          }
        }
      } catch { /* no complete assistant entry */ }
    }
  } catch {
    assistantAt = 0;
    activityAt = 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  const value = { size: stat.size, mtimeMs: stat.mtimeMs, assistantAt, activityAt };
  transcriptCache.set(file, value);
  return value;
}

export function hiddenSessionActivity({ workdir, resumeSid, projectsDir = config.projectsDir }) {
  if (!workdir || !resumeSid) return { lastResponseAt: 0, lastActivityAt: 0 };
  const timestamps = transcriptTimestamps(path.join(projectsDir, projectKey(workdir), `${resumeSid}.jsonl`));
  return { lastResponseAt: timestamps.assistantAt, lastActivityAt: timestamps.activityAt };
}

function lastResponseForPane(session, pane, status, transcriptPath, allowTranscript, options) {
  const response = readResponseStatus(session, pane.pane, options.statusDir || config.statusDir);
  if (response) {
    if (response.transcriptPath && transcriptPath && response.transcriptPath === transcriptPath) return response.lastResponseAt;
    if (!response.transcriptPath && response.lastResponseAt >= (pane.startedAt || 0)) return response.lastResponseAt;
    if (!transcriptPath && response.lastResponseAt >= (pane.startedAt || 0)) return response.lastResponseAt;
  }
  return allowTranscript && transcriptPath ? transcriptTimestamps(transcriptPath).assistantAt : 0;
}

export function aggregateSessionActivity(sessionNames, livePanes, options = {}) {
  const statusDir = options.statusDir || config.statusDir;
  const backgroundPanes = options.backgroundPanes || new Map();
  const detachedSessions = options.detachedSessions || new Map();
  const envIds = sessionEnvIds(options.sessionEnvDir || config.sessionEnvDir);
  const result = {};
  const statesBySession = new Map();
  const transcriptSessions = new Map();
  for (const name of sessionNames) {
    const panes = [...livePanes.values()].filter((pane) => pane.session === name);
    if (!panes.length) {
      const detached = detachedSessions.get(name);
      result[name] = { state: detached ? 'background' : 'absent', updatedAt: detached?.startedAt || 0, lastResponseAt: 0, lastActivityAt: detached?.startedAt || 0 };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: detached?.pids?.length || 0 });
      continue;
    }
    const states = panes.map((pane) => {
      const raw = readPaneStatus(name, pane.pane, statusDir);
      const status = raw
        && (!pane.startedAt || raw.updatedAt >= pane.startedAt)
        ? raw
        : null;
      const transcriptPath = transcriptForPane(pane, status, options, envIds);
      if (transcriptPath) {
        if (!transcriptSessions.has(transcriptPath)) transcriptSessions.set(transcriptPath, new Set());
        transcriptSessions.get(transcriptPath).add(name);
      }
      const rawBackground = readBackgroundStatus(name, pane.pane, statusDir);
      const backgroundStatus = rawBackground
        && (!pane.startedAt || rawBackground.updatedAt >= pane.startedAt)
        && (!rawBackground.transcriptPath || !transcriptPath || rawBackground.transcriptPath === transcriptPath)
        ? rawBackground
        : null;
      const processBackground = backgroundPanes.get(`${name}\0${pane.pane}`);
      const transcriptId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;
      const hasBackgroundProcess = Boolean(processBackground)
        && (!transcriptId || processBackground.sessionIds?.includes(transcriptId));
      return { pane, status, transcriptPath, backgroundStatus, processBackground, hasBackgroundProcess };
    });
    statesBySession.set(name, states);
  }

  for (const [name, states] of statesBySession) {
    const detachedTaskCount = detachedSessions.get(name)?.pids?.length || 0;
    const descendantTaskCount = detachedTaskCount + states.reduce((count, state) => count + Math.max(
      state.processBackground?.pids?.length || 0,
      state.backgroundStatus?.taskCount || 0
    ), 0);
    const lastResponseAt = Math.max(0, ...states.map(({ pane, status, transcriptPath }) => {
      const uniqueTranscript = !transcriptPath || transcriptSessions.get(transcriptPath)?.size === 1;
      return lastResponseForPane(name, pane, status, transcriptPath, uniqueTranscript, { ...options, statusDir });
    }));
    const lastActivityAt = Math.max(lastResponseAt, ...states.map(({ status, transcriptPath }) => {
      const hookAt = status?.updatedAt || 0;
      const transcriptAt = transcriptPath && transcriptSessions.get(transcriptPath)?.size === 1
        ? transcriptTimestamps(transcriptPath).activityAt
        : 0;
      return Math.max(hookAt, transcriptAt);
    }));
    const busy = states.filter(({ status }) => status?.state === 'busy');
    if (busy.length) {
      result[name] = {
        state: 'busy',
        updatedAt: Math.max(...busy.map(({ status }) => status.updatedAt)),
        lastResponseAt,
        lastActivityAt,
      };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
      continue;
    }
    const background = states.filter(({ hasBackgroundProcess }) => hasBackgroundProcess);
    if (background.length || detachedTaskCount) {
      const backgroundActivityAt = Math.max(...background.map(({ backgroundStatus, processBackground }) => (
        Math.max(
          processBackground?.activityAt || processBackground?.startedAt || 0,
          backgroundStatus?.taskCount > 0 ? backgroundStatus.updatedAt : 0
        )
      )), detachedSessions.get(name)?.startedAt || 0);
      result[name] = {
        state: 'background',
        updatedAt: backgroundActivityAt,
        lastResponseAt,
        lastActivityAt: Math.max(lastActivityAt, backgroundActivityAt),
      };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
      continue;
    }
    if (states.some(({ status }) => !status)) {
      result[name] = {
        state: 'unknown',
        updatedAt: Math.max(...states.map(({ pane }) => pane.startedAt || 0)),
        lastResponseAt,
        lastActivityAt,
      };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
      continue;
    }
    result[name] = {
      state: 'idle',
      updatedAt: Math.max(...states.map(({ pane, status }) => status?.updatedAt || pane.startedAt || 0)),
      lastResponseAt,
      lastActivityAt,
    };
    Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
  }
  return result;
}

export function collectSessionActivity(sessionNames, options = {}) {
  const snapshot = options.snapshot || readProcessSnapshot(options.procRoot || '/proc');
  return aggregateSessionActivity(sessionNames, snapshot.claudePanes, {
    ...options,
    backgroundPanes: snapshot.backgroundPanes,
    detachedSessions: snapshot.detachedSessions,
  });
}
