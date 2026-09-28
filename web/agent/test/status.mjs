import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregateSessionActivity, readLiveClaudePanes } from '../src/status.js';
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
  const options = { statusDir: root, sessionEnvDir: path.join(root, 'session-env'), projectsDir: path.join(root, 'projects') };
  assert.deepEqual(aggregateSessionActivity(['alpha', 'beta', 'gone'], panes, options), {
    alpha: { state: 'busy', updatedAt: 101, lastResponseAt: 0 },
    beta: { state: 'idle', updatedAt: 103, lastResponseAt: 0 },
    gone: { state: 'absent', updatedAt: 0, lastResponseAt: 0 },
  });
  fs.mkdirSync(path.join(root, 'stale'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stale', '0.json'), '{"state":"busy","updatedAt":9,"pid":99}\n');
  const stalePanes = new Map([
    ['stale\0' + '0', { session: 'stale', pane: '0', startedAt: 10, pids: [42] }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['stale'], stalePanes, options), {
    stale: { state: 'unknown', updatedAt: 10, lastResponseAt: 0 },
  });
  fs.mkdirSync(path.join(root, 'same-second'), { recursive: true });
  fs.writeFileSync(path.join(root, 'same-second', '0.json'), '{"state":"idle","updatedAt":1000}\n');
  const sameSecondPane = new Map([
    ['same-second\0' + '0', { session: 'same-second', pane: '0', startedAt: 1001, pids: [44] }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['same-second'], sameSecondPane, options), {
    'same-second': { state: 'unknown', updatedAt: 1001, lastResponseAt: 0 },
  });
  fs.writeFileSync(path.join(root, 'same-second', '0.json'), '{"state":"idle","updatedAt":1002}\n');
  assert.deepEqual(aggregateSessionActivity(['same-second'], sameSecondPane, options), {
    'same-second': { state: 'idle', updatedAt: 1002, lastResponseAt: 0 },
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
    input: JSON.stringify({ transcript_path: path.join(root, 'projects', 'hook-test.jsonl') }),
  });
  assert.equal(hook.status, 0);
  const hookStatus = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.json'), 'utf8'));
  assert.equal(hookStatus.state, 'idle');
  assert.equal(hookStatus.transcriptPath, path.join(root, 'projects', 'hook-test.jsonl'));
  assert.ok(hookStatus.updatedAt >= beforeHook && hookStatus.updatedAt <= Date.now());
  const response = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.response.json'), 'utf8'));
  assert.equal(response.transcriptPath, hookStatus.transcriptPath);
  assert.ok(response.lastResponseAt >= beforeHook && response.lastResponseAt <= Date.now());

  const transcript = path.join(root, 'fallback.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-24T11:58:00.000Z' }),
    JSON.stringify({ type: 'system', timestamp: '2026-09-24T11:59:00.000Z' }),
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
    fallback: { state: 'idle', updatedAt: 2000, lastResponseAt: Date.parse('2026-09-24T11:58:00.000Z') },
  });
  console.log('status aggregation and creation timestamp parsing: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
