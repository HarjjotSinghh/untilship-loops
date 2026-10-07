import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { ROOT, engine, copyFixture, hook, check, lastRun, edit, write, cleanup } from './helpers.mjs';

after(cleanup);
const FIXTURE = join(ROOT, 'test', 'fixtures', 'coverage-gate');
const setCoverage = (d, pct) => write(join(d, 'coverage', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct } } }));
function started(pct = 72) {
  const d = copyFixture(FIXTURE);
  setCoverage(d, pct);
  const r = check(d, ['start', 'coverage-gate']);
  assert.equal(r.status, 0, r.stderr);
  return d;
}

describe('frontmatter + globs', () => {
  test('parses scalars, inline lists, block lists, nested maps, block scalars', () => {
    const { data, body } = engine.parseFrontmatter(`---
name: x
max_laps: 3
flag: true
empty: ""
quoted: 'a # not comment'
inline: [a, "b,c", 'd']
list:
  - one
  - '\\bit\\.skip\\('
vars:
  site: public
  crawlers: [GPTBot, ClaudeBot]
script: |
  line 1
  line 2
---
# Body`);
    assert.equal(data.name, 'x');
    assert.equal(data.max_laps, 3);
    assert.equal(data.flag, true);
    assert.equal(data.empty, '');
    assert.equal(data.quoted, 'a # not comment');
    assert.deepEqual(data.inline, ['a', 'b,c', 'd']);
    assert.deepEqual(data.list, ['one', '\\bit\\.skip\\(']);
    assert.deepEqual(data.vars, { site: 'public', crawlers: ['GPTBot', 'ClaudeBot'] });
    assert.equal(data.script, 'line 1\nline 2');
    assert.equal(body.trim(), '# Body');
  });

  test('globs: basename patterns match at any depth, ** spans dirs, braces expand', () => {
    const g = engine.globToRegex;
    assert.ok(g('jest.config.*').test('packages/a/jest.config.ts'));
    assert.ok(g('.c8rc*').test('.c8rc.json'));
    assert.ok(g('.untilship/loops/**').test('.untilship/loops/x/loop.md'));
    assert.ok(!g('.untilship/loops/**').test('src/.untilship/loops/x'));
    assert.ok(g('**/*.{js,ts}').test('a/b/c.ts'));
    assert.ok(g('**/*.{js,ts}').test('c.js'));
    assert.ok(!g('tsconfig*.json').test('src/tsconfig.ts'));
  });

  test('every free loop parses and declares what the engine needs', () => {
    for (const slug of ['idea-to-mvp', 'dependency-upgrade', 'launch-post', 'aeo-setup']) {
      const l = engine.loadLoop(join(ROOT, 'loops', slug, 'loop.md'));
      assert.equal(l.name, slug);
      assert.ok(l.checks.length > 0);
      assert.ok(l.stopWhen, `${slug} has stop_when`);
      for (const s of ['## Trigger', '## Steps', '## Stop when', '## On blocked', '## Report']) assert.ok(l.body.includes(s), `${slug} has ${s}`);
    }
  });
});

describe('stop hook: pass, fail→pass, max laps, tampering', () => {
  test('no active loop: allow stop with empty JSON for every agent', () => {
    const d = copyFixture(FIXTURE);
    for (const a of ['claude', 'codex', 'cursor']) {
      const r = hook(d, a);
      assert.equal(r.status, 0);
      assert.deepEqual(r.json, {});
    }
  });

  test('pass on lap 1: allow + PASSED message, run archived', () => {
    const d = started(95);
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, undefined);
    assert.match(r.json.systemMessage, /PASSED on lap 1\/3 \(line_coverage=95\)/);
    assert.ok(!existsSync(join(d, '.untilship', 'active.json')));
    const { run, report } = lastRun(d);
    assert.equal(run.status, 'passed');
    assert.equal(run.laps.length, 1);
    assert.match(report, /## Result: PASSED on lap 1\/3/);
  });

  test('fail then pass: block with the failing output, then allow', () => {
    const d = started(72);
    const r1 = hook(d, 'claude');
    assert.equal(r1.json.decision, 'block');
    assert.match(r1.json.reason, /lap 1\/3 did NOT pass/);
    assert.match(r1.json.reason, /coverage 72% is below 90%/);
    assert.match(r1.json.reason, /Stop when: line coverage/);
    setCoverage(d, 93.5);
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r2.json.systemMessage, /PASSED on lap 2\/3 \(line_coverage=93.5\)/);
    const { run, report } = lastRun(d);
    assert.deepEqual(run.laps.map((l) => [l.exitCode, l.metric, l.stopHookActive]), [[1, 72, false], [0, 93.5, true]]);
    assert.match(report, /### Lap 1\/3: FAIL/);
    assert.match(report, /### Lap 2\/3: PASS/);
    assert.match(report, /\| passed \| 2\/3 \|/);
    assert.match(report, /1:72 → 2:93.5/);
  });

  test('max laps: final-lap warning, then blocked report and stop allowed', () => {
    const d = started(72);
    const r1 = hook(d, 'claude');
    assert.equal(r1.json.decision, 'block');
    appendFileSync(join(d, 'src', 'app.mjs'), '// attempt 1\n');
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.equal(r2.json.decision, 'block');
    assert.match(r2.json.reason, /FINAL LAP NEXT/);
    assert.match(r2.json.reason, /blockers\.md/);
    const { id } = lastRun(d);
    write(join(d, '.untilship', 'runs', id, 'blockers.md'), 'Coverage tooling is not wired into CI; need a human to decide the threshold.\n');
    appendFileSync(join(d, 'src', 'app.mjs'), '// attempt 2\n');
    const r3 = hook(d, 'claude', { stop_hook_active: true });
    assert.equal(r3.json.decision, undefined, 'must allow the stop at max laps');
    assert.match(r3.json.systemMessage, /BLOCKED after 3 lap\(s\): max laps reached \(3\)/);
    const { run, report } = lastRun(d);
    assert.equal(run.status, 'blocked');
    assert.match(report, /## Result: BLOCKED after 3 lap\(s\)/);
    assert.match(report, /need a human to decide the threshold/);
    assert.ok(!existsSync(join(d, '.untilship', 'active.json')));
  });

  test('tampered threshold: check exits 0 but the lap fails until the file is restored', () => {
    const d = started(72);
    const original = readFileSync(join(d, '.c8rc.json'), 'utf8');
    write(join(d, '.c8rc.json'), JSON.stringify({ 'check-coverage': true, lines: 70 }));
    const r1 = hook(d, 'claude');
    assert.equal(r1.json.decision, 'block');
    assert.match(r1.json.reason, /Protected files changed/);
    assert.match(r1.json.reason, /\.c8rc\.json \(modified\)/);
    assert.match(r1.json.reason, /check command itself passed, but the guards above failed/);
    let { run } = lastRun(d);
    assert.equal(run.laps[0].exitCode, 0);
    assert.equal(run.laps[0].passed, false);
    write(join(d, '.c8rc.json'), original);
    setCoverage(d, 91);
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r2.json.systemMessage, /PASSED on lap 2/);
    ({ run } = lastRun(d));
    assert.equal(run.status, 'passed');
  });

  test('a lockfile appearing mid-run also counts as tampering', () => {
    const d = started(95);
    write(join(d, 'yarn.lock'), '# new lockfile appears\n');
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /yarn\.lock \(added\)/);
  });

  test('forbidden shortcut (it.skip) fails the lap', () => {
    const d = started(95);
    appendFileSync(join(d, 'src', 'app.mjs'), "it.skip('slow test', () => {});\n");
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /Forbidden shortcuts added/);
    assert.match(r.json.reason, /src\/app\.mjs/);
  });

  test('editing the loop definition mid-run fails the lap', () => {
    const d = started(72);
    edit(join(d, '.untilship', 'loops', 'coverage-gate', 'loop.md'), (s) => s.replace('check: node scripts/check-coverage.mjs', 'check: node -e 0'));
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /loop\.md was edited during the run/);
  });

  test('stop_hook_active re-entry with no changes: stalls end the run as blocked', () => {
    const d = copyFixture(FIXTURE);
    edit(join(d, '.untilship', 'loops', 'coverage-gate', 'loop.md'), (s) => s.replace('max_laps: 3', 'max_laps: 8'));
    assert.equal(check(d, ['start', 'coverage-gate']).status, 0);
    assert.equal(hook(d, 'claude').json.decision, 'block');
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.equal(r2.json.decision, 'block');
    assert.match(r2.json.reason, /nothing in the working tree changed/);
    const r3 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r3.json.systemMessage, /BLOCKED after 3 lap\(s\): no progress/);
  });
});

describe('agent protocols', () => {
  test('codex: decision/reason JSON, same as Claude Code', () => {
    const d = started(72);
    const r = hook(d, 'codex');
    assert.equal(r.status, 0);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /lap 1\/3/);
    setCoverage(d, 99);
    assert.match(hook(d, 'codex', { stop_hook_active: true }).json.systemMessage, /PASSED/);
  });

  test('cursor: followup_message to continue; {} to allow; aborted turns are not laps', () => {
    const d = started(72);
    const r = hook(d, 'cursor');
    assert.equal(typeof r.json.followup_message, 'string');
    assert.match(r.json.followup_message, /lap 1\/3/);
    const aborted = hook(d, 'cursor', { status: 'aborted', loop_count: 1 });
    assert.deepEqual(aborted.json, {});
    assert.equal(lastRun(d).run.laps.length, 1);
    setCoverage(d, 99);
    assert.deepEqual(hook(d, 'cursor', { loop_count: 1 }).json, {});
    assert.equal(lastRun(d).run.status, 'passed');
  });

  test('agent auto-detection from stdin shape', () => {
    assert.equal(engine.detectAgent({ turn_id: 't', hook_event_name: 'Stop' }), 'codex');
    assert.equal(engine.detectAgent({ conversation_id: 'c', workspace_roots: [] }), 'cursor');
    assert.equal(engine.detectAgent({ hook_event_name: 'Stop', session_id: 's' }), 'claude');
    assert.equal(engine.detectAgent({}), 'none');
  });

  test('UNTILSHIP_RUNNER=1 makes the in-agent hook a no-op (the runner counts laps)', () => {
    const d = started(72);
    const r = hook(d, 'claude', {}, { env: { UNTILSHIP_RUNNER: '1' } });
    assert.deepEqual(r.json, {});
    assert.equal(lastRun(d).run.laps.length, 0);
  });

  test('a broken run state fails open, loudly', () => {
    const d = started(72);
    const { dir } = lastRun(d);
    writeFileSync(join(dir, 'run.json'), '{ not json');
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, undefined);
    assert.match(r.json.systemMessage, /UntilShip check failed to run/);
    assert.ok(existsSync(join(d, '.untilship', 'errors.log')));
  });
});

describe('CLI: start, peek, status, abort, validation', () => {
  test('peek runs the check without using a lap; status reports laps', () => {
    const d = started(72);
    const p = check(d, ['peek']);
    assert.equal(p.status, 1);
    assert.match(p.stdout, /WOULD FAIL/);
    assert.equal(lastRun(d).run.laps.length, 0);
    hook(d, 'claude');
    const s = JSON.parse(check(d, ['status']).stdout);
    assert.equal(s.active, true);
    assert.equal(s.laps, 1);
  });

  test('a second start is refused while a loop is active; abort finalises the report', () => {
    const d = started(72);
    const again = check(d, ['start', 'coverage-gate']);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already active/);
    const a = check(d, ['abort', 'human said stop']);
    assert.equal(a.status, 0);
    const { run, report } = lastRun(d);
    assert.equal(run.status, 'aborted');
    assert.match(report, /ABORTED[\s\S]*human said stop/);
  });

  test('start validates required vars, required files and unknown {{vars}}', () => {
    const d = copyFixture(FIXTURE);
    const loop = join(d, '.untilship', 'loops', 'coverage-gate', 'loop.md');
    edit(loop, (s) => s.replace('max_laps: 3', 'max_laps: 3\nrequire_vars: [pkg]\nvars:\n  pkg: ""'));
    let r = check(d, ['start', 'coverage-gate']);
    assert.match(r.stderr, /needs --set pkg=\.\.\./);
    r = check(d, ['start', 'coverage-gate', '--set', 'pkg=react']);
    assert.equal(r.status, 0, r.stderr);
    check(d, ['abort']);
    edit(loop, (s) => s.replace('require_vars: [pkg]', 'require_files: [PLAN.md]'));
    r = check(d, ['start', 'coverage-gate']);
    assert.match(r.stderr, /needs PLAN\.md before it can start/);
    edit(loop, (s) => s.replace('require_files: [PLAN.md]', '').replace('check: node scripts/check-coverage.mjs', 'check: node {{nope}}'));
    r = check(d, ['start', 'coverage-gate']);
    assert.match(r.stderr, /references \{\{nope\}\}/);
  });

  test('eval (agent "none") gives human output and exit codes 1 / 0', () => {
    const d = started(72);
    let r = check(d, ['eval']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /did NOT pass/);
    setCoverage(d, 90);
    r = check(d, ['eval']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PASSED on lap 2/);
  });
});
