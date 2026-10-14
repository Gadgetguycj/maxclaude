import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const service = fs.readFileSync(path.join(here, '..', 'mcw-agent.service'), 'utf8');
assert.match(service, /^KillMode=control-group$/m);
assert.doesNotMatch(service, /^KillMode=process$/m);
console.log('mcw-agent service template uses control-group shutdown: PASS');
