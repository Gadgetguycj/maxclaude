// Terminal sockets may attach only to sessions zellij already knows. Unit test with a fake zellij.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-wsgate-'));
const fake = path.join(dir, 'zellij');
fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf 'live-one [Created 3m 2s ago] \\n'
  printf 'gone-one [Created 1h ago] (EXITED - attach to resurrect)\\n'
  printf 'fix-a-x.y_z [Created 5s ago] (current)\\n'
fi
`, { mode: 0o755 });
process.env.MCW_ZELLIJ_BIN = fake;
const { listSessionNames, terminalSocketSession } = await import('../src/sessions.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (err) { failures += 1; console.log(`FAIL ${name}: ${err.message}`); }
}

check('terminal socket paths name their session', () => {
  assert.equal(terminalSocketSession('/ws/terminal/my-session?web_client_id=abc'), 'my-session');
  assert.equal(terminalSocketSession('/ws/terminal/a%2Eb'), 'a.b');
  assert.equal(terminalSocketSession('/ws/terminal'), '');
  assert.equal(terminalSocketSession('/ws/terminal/?web_client_id=abc'), '');
  assert.equal(terminalSocketSession('/ws/control'), null);
  assert.equal(terminalSocketSession('/assets/app.js'), null);
});

const names = await listSessionNames();
check('live, exited and current sessions are all known', () => {
  assert.deepEqual([...names].sort(), ['fix-a-x.y_z', 'gone-one', 'live-one']);
});
check('a deleted name is not known', () => {
  assert.equal(names.has('my-session'), false);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
