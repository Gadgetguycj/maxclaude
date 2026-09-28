import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregateSessionActivity, readLiveBackgroundPanes, readLiveClaudePanes } from '../src/status.js';
import { parseCreatedAt } from '../src/sessions.js';

const now = Date.UTC(2026, 8, 24, 12, 0, 0);
assert.equal(parseCreatedAt('Created 1day 2h 3m 4s ago', now), now - 93784000);
assert.equal(parseCreatedAt('Created 10days 3h 2m 41s ago', now), now - 874961000);
assert.equal(parseCreatedAt('Created 0s ago', now), now);
assert.equal(parseCreatedAt('unparseable', now), 0);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-status-'));
try {
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', '0.json'), '{"state":"busy","updatedAt":101}\n');
  fs.writeFileSync(path.join(root, 'alpha', '1.json'), '{"state":"idle","updatedAt":102}\n');
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'beta', '0.json'), '{"state":"idle","updatedAt":103}\n');
  const panes = new Map([
    ['alpha\0' + '0', { session: 'alpha', pane: '0', startedAt: 10, pids: [10] }],
    ['alpha\0' + '1', { session: 'alpha', pane: '1', startedAt: 11, pids: [11] }],
    ['beta\0' + '0', { session: 'beta', pane: '0', startedAt: 12, pids: [12] }],
  ]);
  const options = { statusDir: root, sessionEnvDir: path.join(root, 'session-env'), projectsDir: path.join(root, 'projects'), now: 104 };
  assert.deepEqual(aggregateSessionActivity(['alpha', 'beta', 'gone'], panes, options), {
    alpha: { state: 'busy', updatedAt: 101, lastResponseAt: 0, lastActivityAt: 102 },
    beta: { state: 'idle', updatedAt: 103, lastResponseAt: 0, lastActivityAt: 103 },
    gone: { state: 'absent', updatedAt: 0, lastResponseAt: 0, lastActivityAt: 0 },
  });
  fs.mkdirSync(path.join(root, 'stale'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stale', '0.json'), '{"state":"busy","updatedAt":9,"pid":99}\n');
  const stalePanes = new Map([
    ['stale\0' + '0', { session: 'stale', pane: '0', startedAt: 10, pids: [42] }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['stale'], stalePanes, options), {
    stale: { state: 'unknown', updatedAt: 10, lastResponseAt: 0, lastActivityAt: 0 },
  });
  fs.mkdirSync(path.join(root, 'same-second'), { recursive: true });
  fs.writeFileSync(path.join(root, 'same-second', '0.json'), '{"state":"idle","updatedAt":1000}\n');
  const sameSecondPane = new Map([
    ['same-second\0' + '0', { session: 'same-second', pane: '0', startedAt: 1001, pids: [44] }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['same-second'], sameSecondPane, options), {
    'same-second': { state: 'unknown', updatedAt: 1001, lastResponseAt: 0, lastActivityAt: 0 },
  });
  fs.writeFileSync(path.join(root, 'same-second', '0.json'), '{"state":"idle","updatedAt":1002}\n');
  assert.deepEqual(aggregateSessionActivity(['same-second'], sameSecondPane, options), {
    'same-second': { state: 'idle', updatedAt: 1002, lastResponseAt: 0, lastActivityAt: 1002 },
  });
  const proc = path.join(root, 'proc');
  fs.mkdirSync(path.join(proc, '42'), { recursive: true });
  fs.writeFileSync(path.join(proc, '42', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=without-pane\0'));
  fs.writeFileSync(path.join(proc, '42', 'cmdline'), Buffer.from('claude\0--resume\0'));
  fs.mkdirSync(path.join(proc, '43'), { recursive: true });
  fs.writeFileSync(path.join(proc, '43', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=without-pane\0'));
  fs.writeFileSync(path.join(proc, '43', 'cmdline'), Buffer.from('claude\0bg-pty-host\0--bg-spare\0'));
  const discovered = readLiveClaudePanes(proc);
  assert.equal(discovered.get('without-pane\0pid-42')?.session, 'without-pane');
  assert.equal(discovered.has('without-pane\0pid-43'), false);
  assert.equal(readLiveBackgroundPanes(path.join(root, 'missing-proc')).size, 0);
  fs.mkdirSync(path.join(proc, '44'), { recursive: true });
  fs.writeFileSync(path.join(proc, '44', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=background-probe\0ZELLIJ_PANE_ID=0\0CLAUDE_CODE_SESSION_ID=bg-id\0'));
  fs.writeFileSync(path.join(proc, '44', 'cmdline'), Buffer.from('bash\0-c\0source /home/example/.claude/shell-snapshots/snapshot-test.sh && sleep 20\0'));
  fs.writeFileSync(path.join(proc, '44', 'status'), 'Name:\tbash\nPPid:\t45\n');
  fs.mkdirSync(path.join(proc, '45'), { recursive: true });
  fs.writeFileSync(path.join(proc, '45', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=background-probe\0ZELLIJ_PANE_ID=0\0'));
  fs.writeFileSync(path.join(proc, '45', 'cmdline'), Buffer.from('claude\0--resume\0bg-id\0'));
  fs.writeFileSync(path.join(proc, '45', 'status'), 'Name:\tclaude\nPPid:\t1\n');
  fs.mkdirSync(path.join(proc, '44', 'fd'));
  const outputFile = path.join(root, 'background-output.log');
  const outputAt = Date.now() + 1000;
  fs.writeFileSync(outputFile, 'progress\n');
  fs.utimesSync(outputFile, new Date(outputAt), new Date(outputAt));
  fs.symlinkSync(outputFile, path.join(proc, '44', 'fd', '1'));
  const backgroundDiscovered = readLiveBackgroundPanes(proc, Date.now(), 0);
  assert.equal(backgroundDiscovered.get('background-probe\0' + '0')?.sessionIds[0], 'bg-id');
  assert.ok(Math.abs(backgroundDiscovered.get('background-probe\0' + '0')?.activityAt - outputAt) <= 1);

  const hookRoot = path.join(root, 'hook-state');
  const beforeHook = Date.now();
  const hook = spawnSync(path.join(import.meta.dirname, '..', 'bin', 'mcw-session-status'), ['idle', 'stop'], {
    env: {
      ...process.env,
      MCW_STATE_DIR: hookRoot,
      CLAUDE_CONFIG_DIR: root,
      ZELLIJ_SESSION_NAME: 'hook-test',
      ZELLIJ_PANE_ID: '0',
    },
    input: JSON.stringify({
      transcript_path: path.join(root, 'projects', 'hook-test.jsonl'),
      background_tasks: [
        { id: 'task-1', type: 'shell', status: 'running' },
        { id: 'task-2', type: 'subagent', status: 'pending' },
      ],
    }),
  });
  assert.equal(hook.status, 0);
  const hookStatus = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.json'), 'utf8'));
  assert.equal(hookStatus.state, 'idle');
  assert.equal(hookStatus.transcriptPath, path.join(root, 'projects', 'hook-test.jsonl'));
  assert.ok(hookStatus.updatedAt >= beforeHook && hookStatus.updatedAt <= Date.now());
  const response = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.response.json'), 'utf8'));
  assert.equal(response.transcriptPath, hookStatus.transcriptPath);
  assert.ok(response.lastResponseAt >= beforeHook && response.lastResponseAt <= Date.now());
  const hookBackground = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.background.json'), 'utf8'));
  assert.equal(hookBackground.transcriptPath, hookStatus.transcriptPath);
  assert.equal(hookBackground.taskCount, 2);
  const hookPane = new Map([
    ['hook-test\0' + '0', { session: 'hook-test', pane: '0', startedAt: beforeHook - 1, pids: [50], command: [], cwd: null }],
  ]);
  const hookedActivity = aggregateSessionActivity(['hook-test'], hookPane, {
    statusDir: path.join(hookRoot, 'session-status'),
    sessionEnvDir: path.join(root, 'session-env'),
    projectsDir: path.join(root, 'projects'),
    now: hookBackground.updatedAt + 1,
  });
  assert.equal(hookedActivity['hook-test'].state, 'idle');
  assert.equal(hookedActivity['hook-test'].lastActivityAt, hookBackground.updatedAt);

  const clearBackground = spawnSync(path.join(import.meta.dirname, '..', 'bin', 'mcw-session-status'), ['idle', 'stop'], {
    env: {
      ...process.env,
      MCW_STATE_DIR: hookRoot,
      CLAUDE_CONFIG_DIR: root,
      ZELLIJ_SESSION_NAME: 'hook-test',
      ZELLIJ_PANE_ID: '0',
    },
    input: JSON.stringify({
      transcript_path: path.join(root, 'projects', 'hook-test.jsonl'),
      background_tasks: [],
    }),
  });
  assert.equal(clearBackground.status, 0);
  const cleared = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.background.json'), 'utf8'));
  assert.equal(cleared.taskCount, 0);
  assert.equal(aggregateSessionActivity(['hook-test'], hookPane, {
    statusDir: path.join(hookRoot, 'session-status'),
    sessionEnvDir: path.join(root, 'session-env'),
    projectsDir: path.join(root, 'projects'),
    now: cleared.updatedAt + 1,
  })['hook-test'].state, 'idle');

  fs.mkdirSync(path.join(root, 'background-probe'), { recursive: true });
  fs.writeFileSync(path.join(root, 'background-probe', '0.json'), '{"state":"idle","updatedAt":2000}\n');
  const backgroundPane = new Map([
    ['background-probe\0' + '0', { session: 'background-probe', pane: '0', startedAt: 1000, pids: [48], command: [], cwd: null }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['background-probe'], backgroundPane, {
    ...options,
    now: 5000,
    backgroundPanes: new Map([[
      'background-probe\0' + '0',
      { session: 'background-probe', pane: '0', startedAt: 2500, pids: [49], sessionIds: ['bg-id'] },
    ]]),
  }), {
    'background-probe': { state: 'background', updatedAt: 2500, lastResponseAt: 0, lastActivityAt: 2500 },
  });

  const transcript = path.join(root, 'fallback.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-24T11:58:00.000Z' }),
    JSON.stringify({ type: 'user', timestamp: '2026-09-24T11:59:00.000Z' }),
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'fallback'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fallback', '0.json'), JSON.stringify({
    state: 'idle', updatedAt: 2000, transcriptPath: transcript,
  }));
  const fallbackPanes = new Map([
    ['fallback\0' + '0', { session: 'fallback', pane: '0', startedAt: 1000, pids: [45], command: [], cwd: null }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['fallback'], fallbackPanes, options), {
    fallback: {
      state: 'idle',
      updatedAt: 2000,
      lastResponseAt: Date.parse('2026-09-24T11:58:00.000Z'),
      lastActivityAt: Date.parse('2026-09-24T11:59:00.000Z'),
    },
  });
  for (const name of ['shared-a', 'shared-b']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, '0.json'), JSON.stringify({
      state: 'idle', updatedAt: name === 'shared-a' ? 3000 : 4000, transcriptPath: transcript,
    }));
  }
  const sharedPanes = new Map([
    ['shared-a\0' + '0', { session: 'shared-a', pane: '0', startedAt: 1000, pids: [46], command: [], cwd: null }],
    ['shared-b\0' + '0', { session: 'shared-b', pane: '0', startedAt: 1000, pids: [47], command: [], cwd: null }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['shared-a', 'shared-b'], sharedPanes, options), {
    'shared-a': {
      state: 'idle', updatedAt: 3000,
      lastResponseAt: 0, lastActivityAt: 3000,
    },
    'shared-b': {
      state: 'idle', updatedAt: 4000,
      lastResponseAt: 0, lastActivityAt: 4000,
    },
  });

  const exactTimes = {
    'session-a': Date.parse('2026-09-28T23:17:01.000Z'),
    'session-b': Date.parse('2026-09-28T23:16:59.000Z'),
    'session-c': Date.parse('2026-09-28T23:16:42.000Z'),
    'session-d': Date.parse('2026-09-28T23:16:38.000Z'),
  };
  const exactPanes = new Map();
  for (const [name, updatedAt] of Object.entries(exactTimes)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, '0.json'), JSON.stringify({
      state: name === 'session-a' || name === 'session-b' ? 'busy' : 'idle',
      updatedAt,
    }));
    exactPanes.set(`${name}\0` + '0', { session: name, pane: '0', startedAt: updatedAt - 10000, pids: [60], command: [], cwd: null });
  }
  const exactActivity = aggregateSessionActivity(Object.keys(exactTimes), exactPanes, {
    ...options,
    now: Date.parse('2026-09-28T23:17:03.000Z'),
    backgroundPanes: new Map([[
      'session-d\0' + '0',
      {
        session: 'session-d', pane: '0',
        startedAt: exactTimes['session-d'] - 1000,
        activityAt: exactTimes['session-d'], pids: [61], sessionIds: ['background-session'],
      },
    ]]),
  });
  assert.deepEqual(Object.entries(exactActivity)
    .sort((left, right) => right[1].lastActivityAt - left[1].lastActivityAt)
    .map(([name, value]) => [name, value.lastActivityAt]), Object.entries(exactTimes));
  console.log('status aggregation and creation timestamp parsing: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
