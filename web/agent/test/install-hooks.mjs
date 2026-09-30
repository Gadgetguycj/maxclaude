import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-hooks-'));
const installer = path.join(import.meta.dirname, '..', 'bin', 'install-hooks.mjs');
const helper = '/usr/local/bin/mcw-session-status';
const settingsPath = path.join(root, 'settings.json');
const existing = { type: 'command', command: '/usr/local/bin/existing-hook' };

try {
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'example-model',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [existing] }],
      PostToolUse: [{ matcher: 'Write', hooks: [existing] }],
    },
  }));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, [installer, helper], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'example-model');
  assert.deepEqual(settings.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [existing] });
  assert.deepEqual(settings.hooks.PostToolUse[0], { matcher: 'Write', hooks: [existing] });

  const expected = {
    UserPromptSubmit: `${helper} busy`,
    PreToolUse: `${helper} busy`,
    PostToolUse: `${helper} busy`,
    Stop: `${helper} idle stop`,
    Notification: `${helper} idle`,
  };
  for (const [event, command] of Object.entries(expected)) {
    const matches = settings.hooks[event].flatMap((group) => group.hooks || [])
      .filter((hook) => hook.type === 'command' && hook.command === command);
    assert.equal(matches.length, 1, `${event} hook must be present exactly once`);
  }

  console.log('hook installation preserves settings and adds each status hook once: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
