// A zellij server that keeps its socket but stops answering must not hang the
// agent. zellij's own session lookup asks every session server and waits
// without a limit, so one such server hung the session list and every
// per-session action, and the errors named no session. Every check must return promptly, keep working for the healthy
// sessions, and name the session that stopped answering.
//
// Real zellij sessions run in a private socket, cache, config and home
// directory, and systemctl --user is cut off, so no real session or unit is
// touched. One server is stopped with SIGSTOP. Before each check its socket is
// put back in zellij's socket directory: the state right after a server stops
// answering, before anything has set it aside.
//
//   node test/zellij-unresponsive.mjs
//
// Needs Linux and zellij. MCW_ZELLIJ_BIN says where zellij is, and
// MCW_ZJ_HELPER which maxagent-zj to use, by default this repository's.
// MCW_AGENT_DIR runs the checks against another copy of the agent. Exits
// non-zero on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* not here */ }
  }
  return null;
}

const zellij = process.env.MCW_ZELLIJ_BIN || onPath('zellij') || path.join(os.homedir(), '.local/bin/zellij');
const helper = process.env.MCW_ZJ_HELPER || fileURLToPath(new URL('../../../bin/maxagent-zj', import.meta.url));
const agentDir = path.resolve(process.env.MCW_AGENT_DIR || fileURLToPath(new URL('..', import.meta.url)));
const LIMIT_MS = Number(process.env.TEST_LIMIT_SECONDS || 45) * 1000;
for (const file of [zellij, helper]) {
  if (!fs.existsSync(file)) { console.error(`${file} not found`); process.exit(2); }
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-zj-'));
const dir = (...parts) => path.join(T, ...parts);
const rt = dir('rt');
const sockDir = path.join(rt, 'zellij', 'contract_version_1');
const stuckDir = path.join(rt, 'zellij', 'stuck');
const zellijConfigDir = dir('config', 'zellij');
const maxclaudeCfg = dir('config', 'maxclaude');
Object.assign(process.env, {
  HOME: dir('home'), XDG_RUNTIME_DIR: rt, XDG_CACHE_HOME: dir('cache'), XDG_CONFIG_HOME: dir('config'),
  // zellij reads ~/.config/zellij before $XDG_CONFIG_HOME; pin it to the private config.
  ZELLIJ_CONFIG_DIR: zellijConfigDir, CLAUDE_CONFIG_DIR: dir('claude'),
  MCW_ZELLIJ_BIN: zellij, MCW_ZJ_HELPER: helper, MCW_ZELLIJ_CONFIG: path.join(zellijConfigDir, 'config.kdl'),
  MCW_STATE_DIR: dir('state'), MCW_STATUS_DIR: dir('state', 'session-status'), MCW_MAXCLAUDE_CFG: maxclaudeCfg,
  MCW_MAXAGENT_CFG: dir('config', 'maxagent'), MCW_SESSION_ENV_DIR: dir('claude', 'session-env'),
  MCW_PROJECTS_DIR: dir('claude', 'projects'), MCW_TRANSCRIPT_DIR: dir('claude', 'projects', 'work'),
  MCW_FILES_ROOT: dir('files'),
});
for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'ZELLIJ_SOCKET_DIR']) delete process.env[key];
for (const d of [dir('home'), dir('cache'), zellijConfigDir, path.join(maxclaudeCfg, 'sessions'), dir('claude', 'sessions'), dir('bin'), dir('work')]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.mkdirSync(rt, { mode: 0o700 });

const servers = new Map();
function cleanup() {
  for (const pid of servers.values()) {
    try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(T, { recursive: true, force: true });
}

if (spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0) {
  console.error('systemctl --user still reaches a user manager; refusing to run');
  cleanup();
  process.exit(2);
}

// Agent log lines are JSON on stdout. Keep them for the checks and still print them.
const logged = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  for (const line of String(chunk).split('\n')) {
    if (line.startsWith('{"ts"')) try { logged.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return write(chunk, ...rest);
};

fs.writeFileSync(path.join(zellijConfigDir, 'config.kdl'), 'show_startup_tips false\nshow_release_notes false\n');
function layout(name, command, args) {
  const file = dir(`${name}.kdl`);
  fs.writeFileSync(file, `layout {\n    pane command=${JSON.stringify(command)} {\n        args ${args.map((a) => JSON.stringify(a)).join(' ')}\n    }\n}\n`);
  return file;
}
const catLayout = layout('cat', 'sh', ['-c', 'echo PANE-READY; exec cat']);
// The rename check needs a pane the agent takes for Claude: a process named
// claude that answers "/rename NAME" the way Claude Code does. It is /bin/sh.
fs.symlinkSync('/bin/sh', dir('bin', 'claude'));
const claudeLayout = layout('claude', dir('bin', 'claude'), ['-c',
  'echo PANE-READY; while IFS= read -r line; do case "$line" in "/rename "*) echo "Session renamed to: ${line#/rename }";; esac; done']);

function serverPid(name) {
  const want = path.join(sockDir, name);
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let args;
    try { args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (path.basename(args[0] || '') === 'zellij' && args.includes('--server') && args.at(-1) === want) return Number(entry);
  }
  return null;
}

async function startSession(name, layoutFile) {
  spawnSync(zellij, ['--layout', layoutFile, 'attach', '--create-background', name], { stdio: 'ignore', timeout: 20000, cwd: dir('work') });
  for (let i = 0; i < 100 && !serverPid(name); i += 1) await new Promise((r) => setTimeout(r, 100));
  const pid = serverPid(name);
  if (!pid) throw new Error(`could not start test session ${name}`);
  servers.set(name, pid);
  return pid;
}

const alive = (pid) => {
  try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
};

// Put a set-aside socket back where zellij looks for it.
function restuck(name) {
  if (fs.existsSync(path.join(stuckDir, name))) {
    fs.renameSync(path.join(stuckDir, name), path.join(sockDir, name));
    fs.rmSync(path.join(`${stuckDir}.info`, name), { force: true });
  }
}

// A pane's screen, read without zellij's lookup touching other servers.
function screen(name) {
  const view = fs.mkdtempSync(path.join(rt, 'zellij', '.view.'));
  try {
    fs.mkdirSync(path.join(view, 'contract_version_1'));
    fs.linkSync(path.join(sockDir, name), path.join(view, 'contract_version_1', name));
    return spawnSync(zellij, ['--session', name, 'action', 'dump-screen', '--full', '--pane-id', '0'],
      { env: { ...process.env, ZELLIJ_SOCKET_DIR: view }, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }).stdout || '';
  } catch { return ''; } finally { fs.rmSync(view, { recursive: true, force: true }); }
}

let fails = 0;
const check = (ok, message) => {
  if (ok) console.log(`PASS: ${message}`); else { fails += 1; console.log(`FAIL: ${message}`); }
};

// Run one agent call under the test limit. A hang is reported, never waited out.
async function call(label, fn) {
  const started = Date.now();
  let timer;
  const result = await Promise.race([
    Promise.resolve().then(fn).then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), LIMIT_MS); }),
  ]);
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.hung) console.log(`--- ${label}: did not return within ${LIMIT_MS / 1000}s`);
  else if (result.error) console.log(`--- ${label}: threw after ${seconds}s: [${result.error.code || 'error'}] ${result.error.message}`);
  else console.log(`--- ${label}: returned after ${seconds}s`);
  return result;
}

try {
  const okPid = await startSession('mcwzj-ok', claudeLayout);
  const delPid = await startSession('mcwzj-del', catLayout);
  const stoppedPid = await startSession('mcwzj-stopped', catLayout);
  await new Promise((r) => setTimeout(r, 1500));
  process.kill(stoppedPid, 'SIGSTOP');
  console.log(`agent: ${agentDir}`);
  console.log(`sessions: mcwzj-ok (pid ${okPid}), mcwzj-del (pid ${delPid}), mcwzj-stopped (pid ${stoppedPid}, stopped with SIGSTOP)`);

  const sessions = await import(pathToFileURL(path.join(agentDir, 'src', 'sessions.js')).href);
  let zj = null;
  try { zj = await import(pathToFileURL(path.join(agentDir, 'src', 'zj.js')).href); } catch (err) { console.log(`note: this agent has no src/zj.js (${err.code || err.message})`); }

  // 0. The failure this test guards against: zellij itself hangs.
  const raw = spawnSync(zellij, ['list-sessions', '-n'], { stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
  console.log(`--- zellij list-sessions: ${raw.signal ? 'killed at the 5s limit, the stopped server blocks zellij\'s own lookup as expected' : `exit ${raw.status}, did not hang`}`);

  // 1. The session list the status lights and the session tree read.
  restuck('mcwzj-stopped');
  const listed = await call('listSessions', () => sessions.listSessions({ fresh: true }));
  const rows = listed.value?.sessions || [];
  const stuckRows = listed.value?.notResponding || [];
  check(listed.value, 'listSessions returned a listing');
  check(rows.some((s) => s.name === 'mcwzj-ok' && !s.exited), 'listSessions lists mcwzj-ok as live');
  check(listed.value && !rows.some((s) => s.name === 'mcwzj-stopped'), 'listSessions leaves out mcwzj-stopped');
  check(stuckRows.some((s) => s.name === 'mcwzj-stopped' && s.serverPid === stoppedPid),
    `listSessions reports mcwzj-stopped under notResponding with server pid ${stoppedPid}`);

  // 2. The terminal socket gate: a stuck name must not be known, or zellij web would make a new session under it.
  restuck('mcwzj-stopped');
  const names = await call('listSessionNames', () => sessions.listSessionNames());
  check(names.value?.has('mcwzj-ok'), 'listSessionNames knows mcwzj-ok');
  check(names.value && !names.value.has('mcwzj-stopped'), 'listSessionNames does not know mcwzj-stopped');
  const warned = logged.filter((line) => line.msg === 'zellij session is not responding' && line.session === 'mcwzj-stopped');
  check(warned.length === 1 && warned[0].serverPid === stoppedPid,
    `the agent logged mcwzj-stopped as not responding once, with its server pid (${warned.length} times)`);

  // 3. A per-session call, while the stopped server's socket is in the socket directory.
  restuck('mcwzj-stopped');
  const panes = await call('zellijSession mcwzj-ok list-panes', () => zj.zellijSession('mcwzj-ok', ['action', 'list-panes', '--json']));
  let paneList = [];
  try { paneList = JSON.parse(panes.value?.stdout || '[]'); } catch { /* reported below */ }
  check(paneList.some((p) => !p.is_plugin), 'a per-session call reached mcwzj-ok while mcwzj-stopped is stopped');
  restuck('mcwzj-stopped');
  const stuckCall = await call('zellijSession mcwzj-stopped list-panes', () => zj.zellijSession('mcwzj-stopped', ['action', 'list-panes', '--json']));
  check(stuckCall.error?.code === 'upstream_unavailable'
    && stuckCall.error.message === 'session mcwzj-stopped is not responding (its zellij server stopped answering)',
  'a per-session call to mcwzj-stopped fails and names it as not responding');

  // 4. Rename sends list-panes, write-chars, send-keys, dump-screen and rename-session
  // to the session. It then fails at the systemd unit, which this test cuts off, and rolls back.
  fs.writeFileSync(path.join(maxclaudeCfg, 'sessions', 'mcwzj-ok.env'), `MAXCLAUDE_WORKDIR=${dir('work')}\n`);
  fs.writeFileSync(path.join(maxclaudeCfg, 'mcwzj-ok.panes'), '1\n');
  restuck('mcwzj-stopped');
  const renamed = await call('renameSession mcwzj-ok to mcwzj-renamed', () => sessions.renameSession({ oldName: 'mcwzj-ok', newName: 'mcwzj-renamed' }));
  check(/^systemctl --user start \S+ failed$/.test(renamed.error?.message || ''),
    'rename passed every zellij step and stopped only at the cut-off systemd unit');
  // zellij refuses a rename back to a name its server saw moments ago ("A session
  // by this name already exists"), so the session can keep the new name.
  const finalName = ['mcwzj-ok', 'mcwzj-renamed'].filter((name) => fs.existsSync(path.join(sockDir, name)));
  console.log(`    the session is now named ${finalName.join(' and ') || '(none)'}`);
  const shown = finalName.length === 1 ? screen(finalName[0]) : '';
  console.log(shown.split('\n').filter((line) => /rename/i.test(line)).map((line) => `    pane: ${line.trim()}`).join('\n'));
  check(/Session renamed to: mcwzj-renamed/.test(shown) && /Session renamed to: mcwzj-ok/.test(shown),
    'the pane received the rename and the rollback');

  // 5. Delete a healthy session while another server is stopped.
  restuck('mcwzj-stopped');
  const deleted = await call('deleteSession mcwzj-del', () => sessions.deleteSession({ name: 'mcwzj-del' }));
  check(deleted.value?.deleted === true, 'deleteSession mcwzj-del returned deleted');
  check(!alive(delPid), `mcwzj-del's server (pid ${delPid}) exited`);

  // 6. Delete the stopped session.
  restuck('mcwzj-stopped');
  const ended = await call('deleteSession mcwzj-stopped', () => sessions.deleteSession({ name: 'mcwzj-stopped' }));
  check(ended.value?.deleted === true, 'deleteSession mcwzj-stopped returned deleted');
  check(!alive(stoppedPid), `mcwzj-stopped's server (pid ${stoppedPid}) exited`);
  check(!fs.existsSync(path.join(sockDir, 'mcwzj-stopped')) && !fs.existsSync(path.join(stuckDir, 'mcwzj-stopped')),
    'no socket is left for mcwzj-stopped');
} catch (err) {
  fails += 1;
  console.log(`FAIL: ${err.stack || err.message}`);
} finally {
  cleanup();
}
console.log(fails ? `RESULT: FAIL (${fails} checks failed)` : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
