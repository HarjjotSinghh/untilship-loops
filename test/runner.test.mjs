// Headless runner (`untilship run`): the fallback that re-invokes an agent until the check
// passes. Tested with fake agents; no model is called.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ROOT, CLI_BIN, installExample, lastRun, tmp, cli, cleanup } from './helpers.mjs';

after(cleanup);

function fakeAgent(dir, body) {
  const f = join(tmp(), 'agent.mjs');
  writeFileSync(f, body);
  return f;
}

describe('untilship run', () => {
  test('re-invokes the agent with the failing output until the check passes', () => {
    const d = installExample('idea-to-mvp', 'claude');
    const state = join(tmp(), 'calls.txt');
    const agent = fakeAgent(d, `
      import { appendFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
      const prompt = process.argv[process.argv.length - 1];
      appendFileSync(${JSON.stringify(state)}, prompt.slice(0, 80).replace(/\\n/g, ' ') + '\\n');
      const calls = readFileSync(${JSON.stringify(state)}, 'utf8').trim().split('\\n').length;
      if (calls === 2) cpSync(${JSON.stringify(join(ROOT, 'examples/idea-to-mvp/solution'))}, process.cwd(), { recursive: true });
      if (process.env.UNTILSHIP_RUNNER !== '1') process.exit(9);
    `);
    const r = spawnSync(process.execPath, [CLI_BIN, 'run', 'idea-to-mvp', '--agent-cmd', `node "${agent}"`, '--dir', d], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /PASSED on lap 2\/8/);
    const calls = readFileSync(state, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /You are running the UntilShip loop "Idea → MVP"/);
    assert.match(calls[1], /lap 1\/8 did NOT pass/);
    assert.equal(lastRun(d).run.status, 'passed');
  });

  test('an agent that makes no progress ends blocked (exit 3)', () => {
    const d = installExample('idea-to-mvp', 'claude');
    const agent = fakeAgent(d, 'process.exit(0);');
    const r = spawnSync(process.execPath, [CLI_BIN, 'run', 'idea-to-mvp', '--agent-cmd', `node "${agent}"`, '--dir', d], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /BLOCKED after 3 lap\(s\): no progress/);
  });

  test('command templates split like a shell would, for simple quoting', () => {
    assert.deepEqual(cli.splitCmd(`claude -p --permission-mode acceptEdits`), ['claude', '-p', '--permission-mode', 'acceptEdits']);
    assert.deepEqual(cli.splitCmd(`node "/a b/agent.mjs" --x ''`), ['node', '/a b/agent.mjs', '--x', '']);
  });
});
