import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { run, runOrThrow, stripAnsi } from './exec.js';
import { RpcError } from './errors.js';
import { log } from './log.js';
import { collectSessionActivity, readLiveClaudePanes } from './status.js';

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mutations = new Map();

export function parseCreatedAt(created, now = Date.now()) {
  const match = /^Created\s+(.+?)\s+ago$/i.exec(`${created}`.trim());
  if (!match) return 0;
  let milliseconds = 0;
  let found = false;
  for (const part of match[1].matchAll(/(\d+)\s*(days?|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi)) {
    found = true;
    const value = Number(part[1]);
    const unit = part[2].toLowerCase();
    if (unit.startsWith('d')) milliseconds += value * 86400000;
    else if (unit.startsWith('h')) milliseconds += value * 3600000;
    else if (unit.startsWith('m')) milliseconds += value * 60000;
    else if (unit.startsWith('s')) milliseconds += value * 1000;
  }
  return found ? Math.max(0, now - milliseconds) : 0;
}

function withSessionLocks(names, fn) {
  const unique = [...new Set(names)].sort();
  const acquire = (index) => {
    if (index === unique.length) return fn();
    const name = unique[index];
    const previous = mutations.get(name) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => mine);
    mutations.set(name, queued);
    return previous.then(() => acquire(index + 1)).finally(() => {
      release();
      if (mutations.get(name) === queued) mutations.delete(name);
    });
  };
  return acquire(0);
}

export function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw new RpcError('bad_request', 'name must match [A-Za-z0-9._-]{1,64} and not be . or ..', { name });
  }
  return name;
}

export async function listSessions() {
  const res = await run(config.zellijBin, ['list-sessions', '-n'], { timeout: 15000 });
  if (res.code !== 0 && !/No active zellij sessions/i.test(`${res.stdout}${res.stderr}`)) {
    throw new RpcError('upstream_unavailable', 'zellij list-sessions failed', {
      exitCode: res.code,
      stdout: res.stdout.slice(-2000),
      stderr: res.stderr.slice(-2000),
    });
  }
  const sessions = [];
  for (const raw of stripAnsi(res.stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*(?:\[([^\]]*)\])?\s*(.*)$/);
    if (!m) continue;
    const rest = `${m[2] || ''} ${m[3] || ''}`;
    sessions.push({
      name: m[1],
      created: m[2] ? m[2].trim() : '',
      createdAt: parseCreatedAt(m[2]),
      exited: /EXITED/i.test(rest),
      current: /\(current\)/i.test(rest),
    });
  }
  const activity = collectSessionActivity(sessions.map((session) => session.name));
  for (const session of sessions) {
    session.activity = activity[session.name]?.state || 'absent';
    session.activityUpdatedAt = activity[session.name]?.updatedAt || 0;
    session.lastResponseAt = activity[session.name]?.lastResponseAt || 0;
  }
  return { sessions };
}

export async function isLive(name) {
  const { sessions } = await listSessions();
  return sessions.some((s) => s.name === name && !s.exited);
}

async function isListed(name) {
  const { sessions } = await listSessions();
  return sessions.some((s) => s.name === name);
}

// Session names zellij knows, live or exited, without the per-session activity scan.
export async function listSessionNames() {
  const res = await run(config.zellijBin, ['list-sessions', '-n'], { timeout: 15000 });
  if (res.code !== 0 && !/No active zellij sessions/i.test(`${res.stdout}${res.stderr}`)) {
    throw new RpcError('upstream_unavailable', 'zellij list-sessions failed', {
      exitCode: res.code,
      stderr: res.stderr.slice(-2000),
    });
  }
  const names = new Set();
  for (const raw of stripAnsi(res.stdout).split('\n')) {
    const line = raw.trim();
    if (!line || /^No active zellij sessions/i.test(line)) continue;
    names.add(line.split(/\s/)[0]);
  }
  return names;
}

// The session a terminal socket path names, '' for the nameless path, or null for any other path.
export function terminalSocketSession(requestPath) {
  const pathname = String(requestPath || '').split('?')[0];
  if (pathname === '/ws/terminal' || pathname === '/ws/terminal/') return '';
  const m = pathname.match(/^\/ws\/terminal\/([^/]+)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

async function systemdEscape(name) {
  const res = await runOrThrow('systemd-escape', [name], { timeout: 10000 });
  return res.stdout.trim();
}

function sessionFiles(name) {
  return {
    env: path.join(config.maxclaudeCfg, 'sessions', `${name}.env`),
    panes: path.join(config.maxclaudeCfg, `${name}.panes`),
  };
}

async function terminalPaneIds(name) {
  const res = await runOrThrow(config.zellijBin, [
    '-s', name, 'action', 'list-panes', '--json', '--command', '--state',
  ], { timeout: 15000 });
  let panes;
  try {
    panes = JSON.parse(res.stdout);
  } catch {
    throw new RpcError('internal', `could not parse the pane list for ${name}`, {
      stdout: res.stdout.slice(-4000),
    });
  }
  const livePaneIds = new Set(
    [...readLiveClaudePanes().values()]
      .filter((pane) => pane.session === name)
      .map((pane) => String(pane.pane)),
  );
  const ids = panes
    .filter((pane) => !pane.is_plugin && !pane.exited && livePaneIds.has(String(pane.id)))
    .map((pane) => String(pane.id));
  if (!ids.length) {
    throw new RpcError('conflict', `session ${name} has no running Claude pane`, { name });
  }
  return ids;
}

async function dumpPane(name, paneId) {
  const res = await runOrThrow(config.zellijBin, [
    '-s', name, 'action', 'dump-screen', '--full', '--pane-id', paneId,
  ], { timeout: 15000 });
  return stripAnsi(res.stdout);
}

function renameReported(screen, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Session renamed to:\\s*${escaped}(?:\\s|$)`, 'i').test(screen);
}

async function renameClaudePane(sessionName, paneId, newName) {
  await runOrThrow(config.zellijBin, [
    '-s', sessionName, 'action', 'write-chars', '--pane-id', paneId, `/rename ${newName}`,
  ], { timeout: 15000 });
  await runOrThrow(config.zellijBin, [
    '-s', sessionName, 'action', 'send-keys', '--pane-id', paneId, 'Enter',
  ], { timeout: 15000 });

  const deadline = Date.now() + 12000;
  let screen = '';
  while (Date.now() < deadline) {
    await sleep(500);
    screen = await dumpPane(sessionName, paneId);
    if (renameReported(screen, newName)) {
      return screen.slice(-4000);
    }
  }
  throw new RpcError('conflict', `Claude did not confirm the session name ${newName}`, {
    paneId,
    screen: screen.slice(-4000),
  });
}

function moveExistingFile(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.renameSync(source, destination);
  return true;
}

async function setUnitMapping(oldName, newName) {
  const oldEscaped = await systemdEscape(oldName);
  const newEscaped = await systemdEscape(newName);
  const oldUnit = `maxclaude-named@${oldEscaped}.service`;
  const newUnit = `maxclaude-named@${newEscaped}.service`;

  await run('systemctl', ['--user', 'stop', oldUnit], { timeout: 60000 });
  await run('systemctl', ['--user', 'reset-failed', oldUnit], { timeout: 15000 });
  await runOrThrow('systemctl', ['--user', 'start', newUnit], { timeout: 60000 });
  const oldActive = await run('systemctl', ['--user', 'is-active', oldUnit], { timeout: 15000 });
  const active = await run('systemctl', ['--user', 'is-active', newUnit], { timeout: 15000 });
  if (oldActive.stdout.trim() === 'active' || active.stdout.trim() !== 'active') {
    throw new RpcError('internal', 'systemd unit mapping is inconsistent after the rename', {
      oldUnit: { stdout: oldActive.stdout.slice(-2000), stderr: oldActive.stderr.slice(-2000) },
      newUnit: { stdout: active.stdout.slice(-2000), stderr: active.stderr.slice(-2000) },
    });
  }
  return { oldUnit, newUnit };
}

function envLines(params) {
  const lines = [`MAXCLAUDE_WORKDIR=${params.workdir}`];
  if (params.org) lines.push(`MAXCLAUDE_ORG=${params.org}`);
  if (params.resumeSid) lines.push(`MAXCLAUDE_RESUME_SID=${params.resumeSid}`);
  if (params.settings) lines.push(`MAXCLAUDE_SETTINGS=${params.settings}`);
  if (params.appendPrompt) lines.push(`MAXCLAUDE_APPEND_PROMPT=${params.appendPrompt}`);
  if (params.extraArgs) lines.push(`MAXCLAUDE_EXTRA_ARGS=${params.extraArgs}`);
  return lines.join('\n') + '\n';
}

function oneLine(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new RpcError('bad_request', `${field} must be a single-line string`, { field });
  }
  return value;
}

export async function createSession(params = {}) {
  const name = validateName(params.name);
  return withSessionLocks([name], () => createSessionLocked(params, name));
}

async function createSessionLocked(params, name) {

  let panes = params.panes === undefined || params.panes === null ? 1 : Number(params.panes);
  if (!Number.isInteger(panes) || panes < 1 || panes > 4) {
    throw new RpcError('bad_request', 'panes must be an integer 1 to 4', { panes: params.panes });
  }

  const workdir = oneLine(params.workdir, 'workdir') || config.defaultWorkdir;
  if (!path.isAbsolute(workdir)) {
    throw new RpcError('bad_request', 'workdir must be an absolute path', { workdir });
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new RpcError('not_found', 'workdir does not exist on this agent host', { workdir });
  }

  const resumeSid = oneLine(params.resumeSid, 'resumeSid');
  let transcript = null;
  if (resumeSid) {
    if (!UUID_RE.test(resumeSid)) {
      throw new RpcError('bad_request', 'resumeSid must be a transcript uuid', { resumeSid });
    }
    transcript = path.join(config.transcriptDir, `${resumeSid}.jsonl`);
    if (!fs.existsSync(transcript)) {
      throw new RpcError('not_found', 'transcript does not exist, refusing to write the env file', {
        resumeSid,
        transcript,
      });
    }
  }

  if (await isLive(name)) {
    throw new RpcError('conflict', `session ${name} is already running`, { name });
  }

  const envFile = path.join(config.maxclaudeCfg, 'sessions', `${name}.env`);
  const panesFile = path.join(config.maxclaudeCfg, `${name}.panes`);
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, envLines({
    workdir,
    org: oneLine(params.org, 'org'),
    resumeSid,
    settings: oneLine(params.settings, 'settings'),
    appendPrompt: oneLine(params.appendPrompt, 'appendPrompt'),
    extraArgs: oneLine(params.extraArgs, 'extraArgs'),
  }));
  fs.writeFileSync(panesFile, `${panes}\n`);

  await runOrThrow('loginctl', ['enable-linger', 'root'], { timeout: 15000 });

  const escaped = await systemdEscape(name);
  const unit = `maxclaude-named@${escaped}.service`;
  const started = await run('systemctl', ['--user', 'start', unit], { timeout: 60000 });
  if (started.code !== 0) {
    throw new RpcError('internal', `failed to start ${unit}`, {
      exitCode: started.code,
      stdout: started.stdout.slice(-4000),
      stderr: started.stderr.slice(-4000),
    });
  }

  const deadline = Date.now() + config.createWaitMs;
  while (Date.now() < deadline) {
    if (await isLive(name)) {
      log.info('session created', { name, panes, workdir, resumeSid, unit });
      return { name, panes, workdir, resumeSid: resumeSid || null, unit, envFile, panesFile, transcript };
    }
    await sleep(500);
  }

  const journal = await run('journalctl', ['--user', '-u', unit, '-n', '40', '--no-pager'], { timeout: 15000 });
  throw new RpcError('internal', `${unit} started but the zellij session never appeared`, {
    unit,
    journal: journal.stdout.slice(-4000),
  });
}

export async function renameSession(params = {}) {
  const oldName = validateName(params.oldName);
  const newName = validateName(params.newName);
  return withSessionLocks([oldName, newName], () => renameSessionLocked(oldName, newName));
}

async function renameSessionLocked(oldName, newName) {
  if (oldName === newName) return { oldName, newName, renamed: false };

  const sessions = (await listSessions()).sessions;
  if (!sessions.some((session) => session.name === oldName && !session.exited)) {
    throw new RpcError('not_found', `session ${oldName} is not running`, { oldName });
  }
  if (sessions.some((session) => session.name === newName)) {
    throw new RpcError('conflict', `session ${newName} already exists`, { newName });
  }

  const oldFiles = sessionFiles(oldName);
  const newFiles = sessionFiles(newName);
  if (!fs.existsSync(oldFiles.env) && !fs.existsSync(oldFiles.panes)) {
    throw new RpcError('conflict', `session ${oldName} has no maxclaude state files`, { oldName });
  }
  for (const destination of Object.values(newFiles)) {
    if (fs.existsSync(destination)) {
      throw new RpcError('conflict', `maxclaude state already exists for ${newName}`, { destination });
    }
  }

  const paneIds = await terminalPaneIds(oldName);
  const claudeReports = [];
  const renamedPanes = [];
  try {
    for (const paneId of paneIds) {
      claudeReports.push(await renameClaudePane(oldName, paneId, newName));
      renamedPanes.push(paneId);
    }
  } catch (err) {
    for (const paneId of renamedPanes) {
      try { await renameClaudePane(oldName, paneId, oldName); } catch { /* preserve the first failure */ }
    }
    throw err;
  }

  let zellijRenamed = false;
  let envMoved = false;
  let panesMoved = false;
  let units = null;
  try {
    await runOrThrow(config.zellijBin, [
      '-s', oldName, 'action', 'rename-session', newName,
    ], { timeout: 15000 });
    zellijRenamed = true;

    envMoved = moveExistingFile(oldFiles.env, newFiles.env);
    panesMoved = moveExistingFile(oldFiles.panes, newFiles.panes);
    units = await setUnitMapping(oldName, newName);

    const current = (await listSessions()).sessions;
    if (current.some((session) => session.name === oldName)
      || !current.some((session) => session.name === newName && !session.exited)) {
      throw new RpcError('internal', 'zellij session rename did not persist', { oldName, newName });
    }

    log.info('session renamed', {
      oldName,
      newName,
      panes: paneIds,
      oldUnit: units.oldUnit,
      newUnit: units.newUnit,
    });
    return {
      oldName,
      newName,
      renamed: true,
      panes: paneIds,
      oldUnit: units.oldUnit,
      newUnit: units.newUnit,
      claudeReports,
    };
  } catch (err) {
    const activeName = zellijRenamed ? newName : oldName;
    if (zellijRenamed) {
      try {
        await runOrThrow(config.zellijBin, [
          '-s', newName, 'action', 'rename-session', oldName,
        ], { timeout: 15000 });
      } catch { /* report the original error */ }
    }
    if (envMoved && fs.existsSync(newFiles.env) && !fs.existsSync(oldFiles.env)) {
      try { fs.renameSync(newFiles.env, oldFiles.env); } catch { /* report the original error */ }
    }
    if (panesMoved && fs.existsSync(newFiles.panes) && !fs.existsSync(oldFiles.panes)) {
      try { fs.renameSync(newFiles.panes, oldFiles.panes); } catch { /* report the original error */ }
    }
    try { await setUnitMapping(newName, oldName); } catch { /* report the original error */ }
    for (const paneId of paneIds) {
      try { await renameClaudePane(oldName, paneId, oldName); } catch {
        try { await renameClaudePane(activeName, paneId, oldName); } catch { /* report the original error */ }
      }
    }
    throw err;
  }
}

export async function deleteSession(params = {}) {
  const name = validateName(params.name);
  return withSessionLocks([name], () => deleteSessionLocked(name));
}

async function deleteSessionLocked(name) {
  const escaped = await systemdEscape(name);
  const unit = `maxclaude-named@${escaped}.service`;

  const stopped = await run('systemctl', ['--user', 'stop', unit], { timeout: 60000 });
  const deleted = await run(config.zellijBin, ['delete-session', '--force', name], { timeout: 30000 });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await isListed(name))) {
      const files = sessionFiles(name);
      const removed = [];
      for (const file of [files.env, files.panes]) {
        try {
          fs.unlinkSync(file);
          removed.push(file);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
      const statusDir = path.join(config.statusDir, name);
      try {
        fs.rmSync(statusDir, { recursive: true, force: true });
        removed.push(statusDir);
      } catch (err) {
        throw new RpcError('internal', `failed to remove status state for ${name}`, { statusDir, error: err.message });
      }
      log.info('session deleted', { name, unit, removed });
      return { name, deleted: true, removed };
    }
    await sleep(500);
  }

  throw new RpcError('internal', `session ${name} is still listed after stop and delete-session`, {
    unit,
    systemctl: { code: stopped.code, stderr: stopped.stderr.slice(-2000) },
    zellij: { code: deleted.code, stdout: deleted.stdout.slice(-2000), stderr: deleted.stderr.slice(-2000) },
  });
}
