import { config } from './config.js';
import { run, stripAnsi } from './exec.js';
import { RpcError } from './errors.js';
import { log } from './log.js';

// zellij's own session lookup asks every session server and waits for each
// reply without a time limit, so one server that keeps its socket but stops
// answering hangs every zellij command. maxagent-zj lists under a deadline,
// sets such a server's socket aside, and sends a per-session command to that
// session's server alone.
const NOT_RESPONDING = 69;
const PAST_DEADLINE = 124;
// Above the helper's own worst case: a missed list, two probes, a second list.
const LIST_TIMEOUT_MS = 30000;
const RUN_TIMEOUT_MS = 25000;
const STOP_TIMEOUT_MS = 40000;
const reported = new Map();

function helper(args, timeout) {
  return run(config.zjHelper, args, {
    timeout,
    env: { MAXAGENT_ZELLIJ: config.zellijBin, MAXAGENT_APP: 'maxclaude' },
  });
}

function detail(res) {
  return { exitCode: res.code, stdout: res.stdout.slice(-2000), stderr: res.stderr.slice(-2000) };
}

export function notRespondingError(name, extra = {}) {
  return new RpcError('upstream_unavailable', `session ${name} is not responding (its zellij server stopped answering)`, { name, ...extra });
}

function reportNewlyStuck(rows) {
  const current = new Set();
  for (const row of rows) {
    current.add(row.name);
    if (reported.get(row.name) === row.serverPid) continue;
    reported.set(row.name, row.serverPid);
    log.warn('zellij session is not responding', { session: row.name, serverPid: row.serverPid, since: row.since });
  }
  for (const name of [...reported.keys()]) if (!current.has(name)) reported.delete(name);
}

// Sessions whose zellij server stopped answering and was set aside, while it still runs.
export async function notRespondingSessions() {
  const res = await helper(['stuck'], 10000);
  if (res.code !== 0) {
    throw new RpcError('upstream_unavailable', 'could not read the zellij sessions that stopped answering', detail(res));
  }
  const rows = res.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, pid, since] = line.split('\t');
    return { name, serverPid: Number(pid) || null, since: since || null };
  });
  reportNewlyStuck(rows);
  return rows;
}

// zellij list-sessions -n lines, without the sessions that stopped answering.
export async function listZellijSessions() {
  const res = await helper(['list', '-n'], LIST_TIMEOUT_MS);
  if (res.code !== 0 && !/No active zellij sessions/i.test(`${res.stdout}${res.stderr}`)) {
    let stuck = [];
    try { stuck = await notRespondingSessions(); } catch { /* report the listing failure */ }
    const names = stuck.map((row) => row.name).join(', ');
    throw new RpcError(res.code === PAST_DEADLINE || res.timedOut ? 'timeout' : 'upstream_unavailable',
      `zellij list-sessions failed${names ? `; not responding: ${names}` : ''}`, { ...detail(res), notResponding: stuck });
  }
  const notResponding = await notRespondingSessions();
  const stuck = new Set(notResponding.map((row) => row.name));
  const lines = [];
  for (const raw of stripAnsi(res.stdout).split('\n')) {
    const line = raw.trim();
    if (!line || /^No active zellij sessions/i.test(line)) continue;
    if (stuck.has(line.split(/\s/)[0])) continue;
    lines.push(line);
  }
  return { lines, notResponding };
}

// zellij --session NAME ARGS, sent to that session's server alone.
export async function zellijSession(name, args, { timeout = RUN_TIMEOUT_MS } = {}) {
  const res = await helper(['run', name, ...args], timeout);
  if (res.code === 0) return res;
  const what = `zellij ${args.join(' ')} on session ${name}`;
  if (res.code === NOT_RESPONDING) throw notRespondingError(name, detail(res));
  if (res.code === PAST_DEADLINE) throw new RpcError('timeout', `${what} did not finish in time, although its zellij server still answers`, detail(res));
  if (res.timedOut) throw new RpcError('timeout', `${what} did not finish within ${timeout}ms`, detail(res));
  throw new RpcError('internal', `${what} failed`, detail(res));
}

// End a session, SIGKILL its server if it does not exit, and delete its resurrection data.
export function stopZellijSession(name) {
  return helper(['stop', name], STOP_TIMEOUT_MS);
}
