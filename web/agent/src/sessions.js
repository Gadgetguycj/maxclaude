import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { run, runOrThrow, stripAnsi } from './exec.js';
import { RpcError } from './errors.js';
import { log } from './log.js';
import { collectSessionActivity, hiddenSessionActivity, readLiveClaudePanes, readSessionProcessSnapshot } from './status.js';
import { viewerCount } from './viewers.js';
import { readWebSharing } from './zellijconfig.js';
import { webStatus } from './zellijweb.js';
import { reserveViewer, releaseViewerLease } from './viewers.js';

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mutations = new Map();
const resumableCache = new Map();

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
  const processSnapshot = readSessionProcessSnapshot();
  const activity = collectSessionActivity(sessions.map((session) => session.name), { snapshot: processSnapshot });
  const operatorClients = attachedOperatorSessions(sessions.map((session) => session.name));
  for (const session of sessions) {
    session.activity = activity[session.name]?.state || 'absent';
    session.activityUpdatedAt = activity[session.name]?.updatedAt || 0;
    session.lastResponseAt = activity[session.name]?.lastResponseAt || 0;
    session.lastActivityAt = activity[session.name]?.lastActivityAt || 0;
    session.descendantTaskCount = activity[session.name]?.descendantTaskCount || 0;
    session.sleeping = false;
    session.viewers = viewerCount(session.name);
    session.conversationIds = [...liveConversationIds(session.name, processSnapshot.claudePanes)];
    session.conversationCount = session.conversationIds.length;
    session.resumable = session.conversationCount === 1 && await isResumableSession(session.name);
    session.operatorActive = operatorClients.ambiguous || operatorClients.sessions.has(session.name) || session.current;
  }
  const liveNames = new Set(sessions.map((session) => session.name));
  sessions.push(...hiddenSessionRows().filter((session) => !liveNames.has(session.name)));
  return { sessions };
}

async function isResumableSession(name) {
  const files = sessionFiles(name);
  if (!fs.existsSync(files.env) || !fs.existsSync(files.panes)) return false;
  const cached = resumableCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const escaped = await systemdEscape(name);
  const unit = `maxclaude-named@${escaped}.service`;
  const result = await run('systemctl', ['--user', 'show', unit, '--property=LoadState', '--property=ActiveState', '--value'], { timeout: 10000 });
  const value = result.code === 0 && isActiveMaxclaudeUnit(result.stdout);
  resumableCache.set(name, { value, expiresAt: Date.now() + 60000 });
  return value;
}

export function isActiveMaxclaudeUnit(output) {
  const [loadState, activeState] = String(output).trim().split(/\s+/);
  return loadState === 'loaded' && activeState === 'active';
}

export function hibernateEligibility(session, { automatic = false, now = Date.now() } = {}) {
  if (session.sleeping) return { eligible: false, reason: 'already sleeping' };
  if (session.current || session.operatorActive) return { eligible: false, reason: 'operator is working in this session' };
  if ((session.conversationCount || 0) > 1) return { eligible: false, reason: 'multiple live Claude conversations cannot be resumed safely' };
  if ((session.conversationCount || 0) === 0) return { eligible: false, reason: 'no live Claude conversation id is available to preserve' };
  if (!session.resumable) return { eligible: false, reason: 'not a resumable maxclaude session' };
  if (session.activity !== 'idle') return { eligible: false, reason: `session is ${session.activity}` };
  if ((session.descendantTaskCount || 0) > 0) return { eligible: false, reason: 'live descendant task process' };
  if ((session.viewers || session.viewerCount || 0) > 0) return { eligible: false, reason: 'browser client is viewing it' };
  if (automatic) {
    const cutoff = config.autoHibernateHours * 3600000;
    if (!cutoff) return { eligible: false, reason: 'automatic hibernation is disabled' };
    if (!session.lastActivityAt) return { eligible: false, reason: 'last real activity is unknown' };
    if (now - session.lastActivityAt < cutoff) return { eligible: false, reason: 'last real activity is below the configured age' };
  }
  return { eligible: true, reason: automatic ? 'idle, resumable, unviewed, no live task, and past the configured inactivity age' : 'idle, resumable, unviewed, and no live task' };
}

export async function hibernateCandidates({ automatic = false } = {}) {
  const { sessions } = await listSessions();
  const candidates = [];
  const excluded = [];
  for (const session of sessions) {
    const eligibility = hibernateEligibility(session, { automatic });
    const row = {
      name: session.name,
      lastActivityAt: session.lastActivityAt,
      reason: eligibility.reason,
      activity: session.activity,
      viewerCount: session.viewers || 0,
      resumable: session.resumable === true,
      operatorActive: session.operatorActive === true,
      descendantTaskCount: session.descendantTaskCount || 0,
      conversationCount: session.conversationCount || 0,
    };
    (eligibility.eligible ? candidates : excluded).push(row);
  }
  return { candidates, excluded };
}

export async function hibernateSession(params = {}) {
  const name = validateName(params.name);
  const automatic = params.automatic === true;
  return withSessionLocks([name], async () => {
    const { sessions } = await listSessions();
    const session = sessions.find((item) => item.name === name);
    if (!session) throw new RpcError('not_found', `session ${name} is not known`, { name });
    const eligibility = hibernateEligibility(session, { automatic });
    if (!eligibility.eligible) throw new RpcError('conflict', `session ${name} cannot be hibernated: ${eligibility.reason}`, { name, reason: eligibility.reason });
    await runOrThrow(config.maxclaudeBin, ['hide', name], { timeout: 60000 });
    recordHiddenActivity(name, session.lastActivityAt, session.createdAt);
    resumableCache.delete(name);
    const sleeping = (await listSessions()).sessions.find((item) => item.name === name);
    if (!sleeping?.sleeping) throw new RpcError('internal', `session ${name} did not enter sleeping state`, { name });
    log.info(automatic ? 'session automatically hibernated' : 'session hibernated', {
      name, reason: eligibility.reason, lastActivityAt: session.lastActivityAt,
    });
    return { name, sleeping: true, lastActivityAt: sleeping.lastActivityAt, reason: eligibility.reason };
  });
}

export async function wakeSession(params = {}) {
  const name = validateName(params.name);
  return withSessionLocks([name], async () => {
    const hidden = hiddenSessionRows().find((session) => session.name === name);
    if (!hidden) throw new RpcError('conflict', `session ${name} is not sleeping`, { name });
    if (!hidden.resumable) throw new RpcError('conflict', `session ${name} has no recorded Claude conversation`, { name });
    const sessionState = readEnvFile(sessionFiles(name).env) || {};
    const resumeSid = sessionState.MAXCLAUDE_RESUME_SID;
    const started = Date.now();
    await startHiddenUnit(name);
    resumableCache.delete(name);
    const deadline = Date.now() + config.createWaitMs;
    while (Date.now() < deadline) {
      const web = await webStatus();
      if (await isLive(name) && readWebSharing() === 'on' && web.online && wakeCommandMatches(name, resumeSid)) {
        const wakeMs = Date.now() - started;
        log.info('session woke', { name, wakeMs });
        return { name, waking: false, wakeMs };
      }
      await sleep(250);
    }
    throw new RpcError('internal', `session ${name} did not return after its unit started`, { name });
  });
}

export function wakeStartPlan(name, metadata, escaped) {
  const expectedUnit = `maxclaude-named@${escaped}.service`;
  if (metadata?.MAXAGENT_UNIT !== expectedUnit) {
    throw new RpcError('conflict', `hidden session ${name} does not record the expected maxclaude unit`, {
      name, expectedUnit, recordedUnit: metadata?.MAXAGENT_UNIT || null,
    });
  }
  return { command: 'systemctl', args: ['--user', 'start', expectedUnit], unit: expectedUnit };
}

async function startHiddenUnit(name) {
  const file = maxagentMetaFile(name);
  const metadata = readEnvFile(file);
  if (!metadata?.MAXAGENT_HIDDEN || metadata.MAXAGENT_HIDDEN !== '1') {
    throw new RpcError('conflict', `session ${name} is not marked hidden`, { name });
  }
  const plan = wakeStartPlan(name, metadata, await systemdEscape(name));
  await runOrThrow(plan.command, plan.args, { timeout: 60000 });
  delete metadata.MAXAGENT_HIDDEN;
  writeMetadata(file, metadata);
}

export function wakeCommandMatches(name, resumeSid, panes = readLiveClaudePanes()) {
  if (!resumeSid) return false;
  const remote = `--remote-control=${name}`;
  return [...panes.values()]
    .filter((pane) => pane.session === name)
    .some((pane) => (pane.commands || []).some((command) => {
      const resumeAt = command.indexOf('--resume');
      return command.includes(remote) && resumeAt >= 0 && command[resumeAt + 1] === resumeSid;
    }));
}

export async function runAutomaticHibernate() {
  if (!config.autoHibernateHours) return { candidates: [], hibernated: [] };
  const preview = await hibernateCandidates({ automatic: true });
  const hibernated = [];
  for (const candidate of preview.candidates) {
    try {
      hibernated.push(await hibernateSession({ name: candidate.name, automatic: true }));
    } catch (err) {
      log.warn('automatic hibernation skipped after recheck', { name: candidate.name, error: String(err.message) });
    }
  }
  return { candidates: preview.candidates, hibernated };
}

export function reserveSessionViewer(params = {}) {
  const name = validateName(params.name);
  return { name, leaseId: reserveViewer(name) };
}

export function releaseSessionViewer(params = {}) {
  if (typeof params.leaseId !== 'string') throw new RpcError('bad_request', 'leaseId is required');
  return { released: releaseViewerLease(params.leaseId) };
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

function maxagentMetaFile(name) {
  return path.join(config.maxagentCfg, 'sessions', `${name}.env`);
}

function readEnvFile(file) {
  try {
    const result = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
    }
    return result;
  } catch {
    return null;
  }
}

function liveConversationIds(name, panes = readLiveClaudePanes()) {
  const ids = new Set();
  for (const pane of panes.values()) {
    if (pane.session !== name) continue;
    for (const pid of pane.pids || []) {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(config.claudeConfigDir, 'sessions', `${pid}.json`), 'utf8'));
        if (typeof value.sessionId === 'string' && UUID_RE.test(value.sessionId)) ids.add(value.sessionId);
      } catch { /* a process can exit while its conversation record is read */ }
    }
  }
  return ids;
}

function hiddenSessionRows() {
  let files = [];
  try { files = fs.readdirSync(path.join(config.maxagentCfg, 'sessions')); } catch { return []; }
  return files.filter((file) => file.endsWith('.env')).flatMap((file) => {
    const name = file.slice(0, -4);
    if (!NAME_RE.test(name)) return [];
    const meta = readEnvFile(maxagentMetaFile(name));
    if (meta?.MAXAGENT_HIDDEN !== '1') return [];
    const session = readEnvFile(sessionFiles(name).env) || {};
    const activity = hiddenSessionActivity({ workdir: session.MAXCLAUDE_WORKDIR, resumeSid: session.MAXCLAUDE_RESUME_SID });
    const recordedActivityAt = Number(meta.MCW_LAST_ACTIVITY_AT) || 0;
    const createdAt = Number(meta.MCW_CREATED_AT) || 0;
    return [{ name, created: '', createdAt, exited: false, current: false, sleeping: true,
      resumable: Boolean(session.MAXCLAUDE_WORKDIR && session.MAXCLAUDE_RESUME_SID), operatorActive: false,
      activity: 'sleeping', activityUpdatedAt: recordedActivityAt || activity.lastActivityAt,
      lastResponseAt: activity.lastResponseAt, lastActivityAt: recordedActivityAt || activity.lastActivityAt,
      descendantTaskCount: 0, viewers: 0, conversationCount: 1 }];
  });
}

function recordHiddenActivity(name, lastActivityAt, createdAt) {
  const file = maxagentMetaFile(name);
  const meta = readEnvFile(file);
  if (!meta) throw new RpcError('internal', `hidden metadata is missing for ${name}`, { name, file });
  meta.MCW_LAST_ACTIVITY_AT = String(Math.max(0, Number(lastActivityAt) || 0));
  meta.MCW_CREATED_AT = String(Math.max(0, Number(createdAt) || 0));
  writeMetadata(file, meta);
}

function writeMetadata(file, metadata) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, Object.entries(metadata).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function parseZellijClientCommand(command, envSession = '', knownNames = []) {
  if (envSession && NAME_RE.test(envSession)) return { names: [envSession], ambiguous: false };
  const attach = Math.max(command.lastIndexOf('attach'), command.lastIndexOf('a'));
  const watch = Math.max(command.lastIndexOf('watch'), command.lastIndexOf('w'));
  const verb = Math.max(attach, watch);
  if (verb < 0) return { names: [], ambiguous: true };
  if (command.indexOf('--index', verb + 1) >= 0) return { names: [], ambiguous: true };
  const takesValue = new Set(['--ca-cert', '--token']);
  const names = [];
  for (let index = verb + 1; index < command.length; index += 1) {
    const arg = command[index];
    if (takesValue.has(arg)) { index += 1; continue; }
    if (!arg.startsWith('-')) names.push(arg);
  }
  const name = names.at(-1);
  if (!name || !knownNames.includes(name)) return { names: [], ambiguous: true };
  return { names: [name], ambiguous: false };
}

export function isZellijServerCommand(command) {
  return command.includes('--server');
}

export function isZellijClientCommand(command) {
  return command.includes('attach') || command.includes('a') || command.includes('watch') || command.includes('w');
}

function attachedOperatorSessions(knownNames = []) {
  const sessions = new Set();
  let ambiguous = false;
  let entries = [];
  try { entries = fs.readdirSync('/proc', { withFileTypes: true }); } catch { return { sessions, ambiguous: true }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let command = [];
    try { command = fs.readFileSync(path.join('/proc', entry.name, 'cmdline')).toString('utf8').split('\0').filter(Boolean); } catch { continue; }
    if (path.basename(command[0] || '') !== path.basename(config.zellijBin)) continue;
    if (isZellijServerCommand(command)) continue;
    if (!isZellijClientCommand(command)) continue;
    let envSession = '';
    try {
      const env = fs.readFileSync(path.join('/proc', entry.name, 'environ')).toString('utf8').split('\0');
      envSession = env.find((value) => value.startsWith('ZELLIJ_SESSION_NAME='))?.slice('ZELLIJ_SESSION_NAME='.length) || '';
    } catch { /* the client can exit while its environment is read */ }
    const parsed = parseZellijClientCommand(command, envSession, knownNames);
    for (const name of parsed.names) sessions.add(name);
    ambiguous ||= parsed.ambiguous;
  }
  return { sessions, ambiguous };
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

  const workdir = oneLine(params.workdir, 'workdir') || '/workspace';
  if (!path.isAbsolute(workdir)) {
    throw new RpcError('bad_request', 'workdir must be an absolute path', { workdir });
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new RpcError('not_found', 'workdir does not exist on the session host', { workdir });
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
