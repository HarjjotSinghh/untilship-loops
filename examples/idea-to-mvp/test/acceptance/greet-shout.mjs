import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const r = spawnSync(process.execPath, ['src/greet.mjs', ...["Ada","--shout"]], { encoding: 'utf8' });
assert.equal(r.status, 0, r.stderr);
assert.equal(r.stdout.trim(), "HELLO, ADA!");
console.log('ok');
