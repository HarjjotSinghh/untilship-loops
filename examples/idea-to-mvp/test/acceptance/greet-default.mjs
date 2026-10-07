import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const r = spawnSync(process.execPath, ['src/greet.mjs', ...[]], { encoding: 'utf8' });
assert.equal(r.status, 0, r.stderr);
assert.equal(r.stdout.trim(), "Hello, world!");
console.log('ok');
