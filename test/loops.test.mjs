// End-to-end: install each free loop into a copy of its example repo with the real CLI,
// start it, and drive the real stop hook from fail to pass (and through its guards).
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ROOT, installExample, overlay, hook, check, lastRun, edit, cleanup } from './helpers.mjs';

after(cleanup);

describe('idea-to-mvp', () => {
  test('fails with 1/3 items, passes once the CLI is built', () => {
    const d = installExample('idea-to-mvp', 'claude');
    assert.equal(check(d, ['start', 'idea-to-mvp']).status, 0);
    const r1 = hook(d, 'claude');
    assert.equal(r1.json.decision, 'block');
    assert.match(r1.json.reason, /ACCEPTANCE: 1\/3 passed/);
    assert.match(r1.json.reason, /FAIL 2\. `greet` with no name/);
    overlay('idea-to-mvp', d);
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r2.json.systemMessage, /PASSED on lap 2\/8 \(items_passed=3\)/);
    assert.match(lastRun(d).report, /items_passed by lap \|\n\|---\|---\|---\|---\|\n\| passed \| 2\/8 \| [\d.]+ min \| 1:1 → 2:3 \|/);
  });

  test('cannot start without an agreed checklist', () => {
    const d = installExample('idea-to-mvp', 'claude');
    rmSync(join(d, 'ACCEPTANCE.md'));
    const r = check(d, ['start', 'idea-to-mvp']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs ACCEPTANCE\.md before it can start/);
  });

  test('editing the checklist mid-run is tampering, even when it would make the check pass', () => {
    const d = installExample('idea-to-mvp', 'claude');
    check(d, ['start', 'idea-to-mvp']);
    edit(join(d, 'ACCEPTANCE.md'), (s) => s.split('- [ ] `greet` with no name')[0]);
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /ACCEPTANCE\.md \(modified\)/);
  });
});

describe('dependency-upgrade', () => {
  const start = (d) => check(d, ['start', 'dependency-upgrade', '--set', 'package=tiny-math', '--set', 'target=^2.0.0',
    '--set', 'build=node scripts/build.mjs', '--set', 'typecheck=node -e 0', '--set', 'test=node --test test/invoice.test.mjs']);

  test('refuses to start without package and target', () => {
    const d = installExample('dependency-upgrade', 'codex');
    const r = check(d, ['start', 'dependency-upgrade']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--set package=\.\.\. --set target=\.\.\./);
  });

  test('version not bumped → bumped but build breaks → call sites fixed → pass (codex protocol)', () => {
    const d = installExample('dependency-upgrade', 'codex');
    assert.equal(start(d).status, 0, 'start');
    const r1 = hook(d, 'codex');
    assert.equal(r1.json.decision, 'block');
    assert.match(r1.json.reason, /VERSION NOT UPGRADED/);
    overlay('dependency-upgrade', d, ['node_modules']);
    edit(join(d, 'package.json'), (s) => s.replace('"tiny-math": "^1.2.0"', '"tiny-math": "^2.0.0"'));
    const r2 = hook(d, 'codex', { stop_hook_active: true });
    assert.equal(r2.json.decision, 'block');
    assert.match(r2.json.reason, /Failing check: node scripts\/build\.mjs/);
    assert.match(r2.json.reason, /does not provide an export named 'add'/);
    overlay('dependency-upgrade', d, ['src']);
    const r3 = hook(d, 'codex', { stop_hook_active: true });
    assert.equal(r3.json.decision, undefined);
    assert.match(r3.json.systemMessage, /PASSED on lap 3\/8/);
  });

  test('skipping a failing test is caught even though the suite then passes', () => {
    const d = installExample('dependency-upgrade', 'claude');
    start(d);
    overlay('dependency-upgrade', d);
    edit(join(d, 'package.json'), (s) => s.replace('"tiny-math": "^1.2.0"', '"tiny-math": "^2.0.0"'));
    edit(join(d, 'test', 'invoice.test.mjs'), (s) => s.replace("test('empty invoice", "test.skip('empty invoice"));
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /Forbidden shortcuts added/);
    assert.match(r.json.reason, /test\/invoice\.test\.mjs/);
  });
});

describe('dependency-upgrade guards', () => {
  const start = (d, ...extra) => check(d, ['start', 'dependency-upgrade', '--set', 'package=tiny-math', '--set', 'target=^2.0.0',
    '--set', 'build=node scripts/build.mjs', '--set', 'typecheck=node -e 0', '--set', 'test=npm test --silent', ...extra]);
  const upgrade = (d) => { overlay('dependency-upgrade', d); edit(join(d, 'package.json'), (s) => s.replace('"tiny-math": "^1.2.0"', '"tiny-math": "^2.0.0"')); };

  test('rewriting the test script in package.json fails the lap; bumping dependencies does not', () => {
    const d = installExample('dependency-upgrade', 'claude');
    assert.equal(start(d).status, 0);
    upgrade(d);
    edit(join(d, 'package.json'), (s) => s.replace('"test": "node --test test/invoice.test.mjs"', '"test": "node -e 0"'));
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /package\.json#scripts \(modified\)/);
    assert.doesNotMatch(r.json.reason, /dependencies/);
  });

  test('editing an existing test fails; a new test file is fine; --set protect_tests= lifts it', () => {
    const d = installExample('dependency-upgrade', 'claude');
    assert.equal(start(d).status, 0);
    upgrade(d);
    writeFileSync(join(d, 'test', 'extra.test.mjs'), "import { test } from 'node:test';\ntest('new', () => {});\n");
    edit(join(d, 'test', 'invoice.test.mjs'), (s) => s + '\n// weakened\n');
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /test\/invoice\.test\.mjs \(modified\)/);
    assert.doesNotMatch(r.json.reason, /extra\.test\.mjs/);
    edit(join(d, 'test', 'invoice.test.mjs'), (s) => s.replace('\n// weakened\n', ''));
    assert.match(hook(d, 'claude', { stop_hook_active: true }).json.systemMessage, /PASSED/);

    const d2 = installExample('dependency-upgrade', 'claude');
    assert.equal(start(d2, '--set', 'protect_tests=').status, 0);
    upgrade(d2);
    edit(join(d2, 'test', 'invoice.test.mjs'), (s) => s + '\n// updated on purpose\n');
    assert.match(hook(d2, 'claude').json.systemMessage, /PASSED/);
  });
});

describe('idea-to-mvp guards', () => {
  test('existing tests and scripts are frozen; new scripts are allowed', () => {
    const d = installExample('idea-to-mvp', 'claude');
    assert.equal(check(d, ['start', 'idea-to-mvp']).status, 0);
    overlay('idea-to-mvp', d);
    edit(join(d, 'package.json'), (s) => { const p = JSON.parse(s); p.scripts = { ...(p.scripts || {}), 'new-script': 'node -e 0' }; return JSON.stringify(p, null, 2); });
    assert.match(hook(d, 'claude').json.systemMessage, /PASSED/);
  });

  test('editing a test that existed at start fails the lap', () => {
    const d = installExample('idea-to-mvp', 'claude');
    assert.equal(check(d, ['start', 'idea-to-mvp']).status, 0);
    overlay('idea-to-mvp', d);
    const testDir = join(d, 'test');
    const f = readdirSync(testDir, { recursive: true }).map(String).find((x) => /\.m?[jt]s$/.test(x));
    appendFileSync(join(testDir, f), '\n// edited\n');
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /\(modified\)/);
  });
});

describe('launch-post (panel-scored)', () => {
  const judge = (d) => ({ UNTILSHIP_JUDGE: `node "${join(d, 'fake-judge.mjs')}"` });

  test('gates fail on the hype draft; the rewrite clears the external panel', () => {
    const d = installExample('launch-post', 'cursor');
    assert.equal(check(d, ['start', 'launch-post']).status, 0);
    const r1 = hook(d, 'cursor', {}, { env: judge(d) });
    assert.match(r1.json.followup_message, /FAIL no hype words: remove: excited to announce/);
    assert.match(r1.json.followup_message, /PANEL: skipped until every gate passes/);
    overlay('launch-post', d);
    const r2 = hook(d, 'cursor', { loop_count: 1 }, { env: judge(d) });
    assert.deepEqual(r2.json, {});
    const { run, report } = lastRun(d);
    assert.equal(run.status, 'passed');
    assert.equal(run.laps[1].metric, 90);
    assert.match(report, /panel-scored, model-judged/);
    assert.match(report, /score by lap \|[\s\S]*2:90/);
  });

  test('self-judged panel: stale scores are rejected, fresh scores pass, require_external_judge blocks', () => {
    const d = installExample('launch-post', 'claude');
    overlay('launch-post', d);
    check(d, ['start', 'launch-post']);
    const post = readFileSync(join(d, 'launch', 'post.md'), 'utf8');
    const scores = { hook: 9, clarity: 9, proof: 8, reader_value: 9, voice: 9, call_to_action: 9 };
    writeFileSync(join(d, 'launch', 'panel.json'), JSON.stringify({ post_sha256: 'stale', judges: [{ name: 'a', scores }] }));
    const r1 = hook(d, 'claude');
    assert.match(r1.json.reason, /scores a different version of the post/);
    const sha = check(d, ['peek']).stdout; // peek shows the same failure without using a lap
    assert.match(sha, /post_sha256 mismatch/);
    writeFileSync(join(d, 'launch', 'panel.json'), JSON.stringify({ post_sha256: createHash('sha256').update(post).digest('hex'), judges: [{ judges: [{ name: 'a', scores }, { name: 'b', scores }] }] }));
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r2.json.systemMessage, /PASSED on lap 2\/6 \(score=88\)/);
    assert.match(lastRun(d).run.laps[1].commands[0].stdoutTail, /JUDGE: self-judged/);

    const d2 = installExample('launch-post', 'claude');
    overlay('launch-post', d2);
    check(d2, ['start', 'launch-post', '--set', 'require_external_judge=true']);
    writeFileSync(join(d2, 'launch', 'panel.json'), JSON.stringify({ post_sha256: createHash('sha256').update(post).digest('hex'), judges: [{ name: 'a', scores }] }));
    const r3 = hook(d2, 'claude');
    assert.equal(r3.json.decision, 'block');
    assert.match(r3.json.reason, /Self-judged panels cannot pass this run/);
  });

  test('editing the brief mid-run is tampering', () => {
    const d = installExample('launch-post', 'claude');
    check(d, ['start', 'launch-post']);
    appendFileSync(join(d, 'launch', 'brief.md'), '- **Proof**: 1,000,000 users (invented)\n');
    const r = hook(d, 'claude', {}, { env: judge(d) });
    assert.match(r.json.reason, /launch\/brief\.md \(modified\)/);
  });
});

describe('aeo-setup', () => {
  test('0/5 on the bare site, 5/5 after the fixes (local mode)', () => {
    const d = installExample('aeo-setup', 'claude');
    assert.equal(check(d, ['start', 'aeo-setup']).status, 0);
    const r1 = hook(d, 'claude');
    assert.match(r1.json.reason, /AEO: 0\/5 checks passed/);
    assert.match(r1.json.reason, /disallows "\/" for: GPTBot/);
    overlay('aeo-setup', d);
    const r2 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r2.json.systemMessage, /PASSED on lap 2\/8 \(checks_passed=5\)/);
  });

  test('base_url mode fetches llms.txt and the sitemap over HTTP', async () => {
    const d = installExample('aeo-setup', 'claude');
    overlay('aeo-setup', d);
    const served = { '/llms.txt': readFileSync(join(d, 'public', 'llms.txt'), 'utf8') };
    const server = createServer((req, res) => {
      if (req.url === '/sitemap.xml') {
        res.end(`<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:${server.address().port}/</loc></url></urlset>`);
      } else if (served[req.url]) res.end(served[req.url]);
      else { res.statusCode = 404; res.end('nope'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { spawn } = await import('node:child_process');
    const run = (extra) => new Promise((resolve) => {
      const p = spawn(process.execPath, [join(d, '.untilship/loops/aeo-setup/aeo-check.mjs'), '--site-dir', 'public', '--base-url', extra], { cwd: d });
      let out = ''; p.stdout.on('data', (c) => { out += c; });
      p.on('close', (code) => resolve({ code, out }));
    });
    const ok = await run(base);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /\[PASS\] sitemap: reachable at http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml, 1 URL/);
    assert.match(ok.out, /robots\.txt Sitemap points at https:\/\/tally\.example\.com\/sitemap\.xml/);
    delete served['/llms.txt'];
    const bad = await run(base);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /GET http:\/\/127\.0\.0\.1:\d+\/llms\.txt -> 404/);
    server.close();
  });
});
