import assert from 'node:assert/strict';
import { MAX_UPLOAD_BYTES, safeRelativePath } from '../src/files.js';

assert.equal(safeRelativePath('photo.png'), 'photo.png');
assert.equal(safeRelativePath('folder one/photo.png'), 'folder one/photo.png');
assert.equal(MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024);

for (const unsafe of [
  '../secret',
  'folder/../secret',
  '/home/tester/secret',
  './secret',
  'folder//secret',
  'folder\\secret',
  'folder/./secret',
  '',
]) {
  assert.throws(() => safeRelativePath(unsafe), /upload path/);
}

process.stdout.write('file path validation and 2 GB cap: PASS\n');
