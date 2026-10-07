// Guards: forbidden markers (count increase vs baseline), protect_existing (new files allowed),
// protect_json (package.json#scripts and friends), and forbid_in scoping.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { ROOT, engine, tmp, hook, check, edit, cleanup } from './helpers.mjs';

after(cleanup);

const FREE = ['dependency-upgrade', 'idea-to-mvp'];
const loopOf = (slug) => engine.loadLoop(join(ROOT, 'loops', slug, 'loop.md'));

// One sample line per marker the free loops must catch, by language.
const MUST_CATCH = {
  '.skip(': "it.skip('slow', () => {});",
  '.only(': "test.only('focus', () => {});",
  '.skip.each(': "describe.skip.each([1, 2])('table %i', () => {});",
  '.only.each`': 'test.only.each`a | b`(\'x\', () => {});',
  'xit(': "xit('later', () => {});",
  'xdescribe(': "xdescribe('later', () => {});",
  'xtest(': "xtest('later', () => {});",
  'test.todo(': "test.todo('write me');",
  'this.skip()': 'before(function () { this.skip(); });',
  '@ts-ignore': '// @ts-ignore',
  '@ts-expect-error': '// @ts-expect-error',
  '@ts-nocheck': '// @ts-nocheck',
  'eslint-disable': '/* eslint-disable no-undef */',
  'istanbul ignore': '/* istanbul ignore next */',
  'c8 ignore': '/* c8 ignore next 3 */',
  'v8 ignore': '/* v8 ignore next */',
  '# pragma: no cover': 'def f():  # pragma: no cover',
  '@pytest.mark.skip': '@pytest.mark.skip(reason="flaky")',
  '@pytest.mark.skipif': '@pytest.mark.skipif(True, reason="x")',
  'pytest.skip(': '    pytest.skip("not today")',
  'unittest.skip': '@unittest.skip("x")',
  't.Skip(': '\tt.Skip("flaky on CI")',
  't.SkipNow()': '\tt.SkipNow()',
  '#[ignore]': '#[ignore]',
  '#[ignore = ...]': '#[ignore = "slow"]',
  '@Disabled': '@Disabled("later")',
};
// Ordinary code that must not trip the guards.
const MUST_NOT_CATCH = [
  'let v = iter.skip(2).take(3);', 'model.fit(X, y)', 'const only = items.filter(Boolean);',
  "it('works', () => { expect(skip).toBe(1); });", 'describe("skipping rules", () => {});',
  'fn ignore_me() {}', '# a normal python comment', 'const todo = test.name;',
];

describe('forbidden markers in the free loops', () => {
  for (const slug of FREE) {
    test(`${slug}: catches every listed marker, and not ordinary code`, () => {
      const res = loopOf(slug).forbid.map((p) => new RegExp(p));
      for (const [marker, line] of Object.entries(MUST_CATCH)) {
        assert.ok(res.some((r) => r.test(line)), `${slug} misses ${marker}: ${line}`);
      }
      for (const line of MUST_NOT_CATCH) {
        const hit = res.find((r) => r.test(line));
        assert.equal(hit, undefined, `${slug} false positive on ${line} (${hit})`);
      }
    });

    test(`${slug}: forbid_in covers source and tests, never node_modules, dist or .untilship`, () => {
      const d = tmp();
      const files = {
        'src/a.ts': '// @ts-ignore\n', 'test/a.test.js': "it.skip('x', () => {})\n", 'app/m.py': '@pytest.mark.skip\n',
        'pkg/x_test.go': 't.Skip("x")\n', 'src/lib.rs': '#[ignore]\n', '.npmrc': 'script-shell=true\n',
        'node_modules/dep/index.js': '// @ts-ignore\n', 'dist/bundle.js': '/* istanbul ignore next */\n',
        'build/out.js': '// eslint-disable\n', 'coverage/lcov-report/x.js': '/* istanbul ignore next */\n',
        'vendor/lib.js': '// @ts-ignore\n', 'public/app.min.js': '// eslint-disable\n',
        '.untilship/loops/x/check.mjs': '// @ts-ignore\n', 'README.md': '`it.skip(` is forbidden\n',
      };
      for (const [f, s] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), s); }
      const l = loopOf(slug);
      const counted = Object.keys(engine.countForbidden(d, l.forbid, l.forbidIn)).sort();
      assert.deepEqual(counted, ['.npmrc', 'app/m.py', 'pkg/x_test.go', 'src/a.ts', 'src/lib.rs', 'test/a.test.js']);
    });
  }
});

/* A throwaway loop in a temp repo, so each guard can be driven through the real hook. */
function repo(frontmatter, files = {}) {
  const d = tmp();
  const base = {
    'package.json': JSON.stringify({ name: 'g', scripts: { test: 'node --test', build: 'node build.mjs' }, dependencies: { a: '^1.0.0' } }, null, 2) + '\n',
    'src/app.mjs': 'export const x = 1;\n',
    'test/app.test.mjs': "import { test } from 'node:test';\ntest('x', () => {});\n",
    ...files,
  };
  for (const [f, s] of Object.entries(base)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), s); }
  mkdirSync(join(d, '.untilship', 'loops', 'g'), { recursive: true });
  writeFileSync(join(d, '.untilship', 'loops', 'g', 'loop.md'), `---\nname: g\ncheck: node -e 0\nmax_laps: 5\nstall_limit: 0\nprotect: []\n${frontmatter}\n---\n# g\n`);
  return d;
}
const yamlList = (key, items) => `${key}:\n${items.map((x) => `  - '${String(x).replace(/'/g, "''")}'`).join('\n')}`;
const start = (d, ...set) => {
  const r = check(d, ['start', 'g', ...set.flatMap((s) => ['--set', s])]);
  assert.equal(r.status, 0, r.stderr);
};
const lap = (d) => hook(d, 'claude', { stop_hook_active: true }).json;
const passes = (j) => assert.match(j.systemMessage || '', /PASSED/, j.reason);

describe('forbidden markers: count increase vs baseline', () => {
  const fm = () => [yamlList('forbid', loopOf('dependency-upgrade').forbid), yamlList('forbid_in', loopOf('dependency-upgrade').forbidIn)].join('\n');

  test('markers already in the code at start do not fail a lap; a new one does', () => {
    const d = repo(fm(), { 'src/old.ts': '// @ts-ignore\nconst a = 1;\n', 'test/old.test.mjs': "it.skip('legacy', () => {});\n" });
    start(d);
    passes(lap(d));
    start(d);
    appendFileSync(join(d, 'src', 'old.ts'), '// @ts-expect-error\n');
    const j = lap(d);
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /Forbidden shortcuts added/);
    assert.match(j.reason, /src\/old\.ts/);
  });

  test('a second copy of an existing marker in the same file counts', () => {
    const d = repo(fm(), { 'app/m.py': '# pragma: no cover\n' });
    start(d);
    appendFileSync(join(d, 'app', 'm.py'), 'x = 1  # pragma: no cover\n');
    assert.match(lap(d).reason, /app\/m\.py: .*x1/);
  });

  test('markers in dist/ or node_modules/ (build output, installs) never fail a lap', () => {
    const d = repo(fm());
    start(d);
    for (const f of ['dist/index.js', 'node_modules/dep/index.js', 'build/x.js']) {
      mkdirSync(join(d, dirname(f)), { recursive: true });
      writeFileSync(join(d, f), '/* istanbul ignore next */\n// @ts-ignore\n/* eslint-disable */\n');
    }
    passes(lap(d));
  });

  test('pointing npm at a no-op shell via .npmrc is caught', () => {
    const d = repo(fm(), { '.npmrc': 'legacy-peer-deps=true\n' });
    start(d);
    appendFileSync(join(d, '.npmrc'), 'script-shell=/usr/bin/true\n');
    assert.match(lap(d).reason, /\.npmrc/);
  });
});

describe('protect_existing: baseline files frozen, new files allowed', () => {
  test('adding a new test file passes; editing or deleting a baseline test fails', () => {
    const d = repo("protect_existing: ['@tests']", { 'test/other.test.mjs': '// other\n' });
    start(d);
    mkdirSync(join(d, 'test', 'unit'), { recursive: true });
    writeFileSync(join(d, 'test', 'unit', 'new.test.mjs'), '// new\n');
    writeFileSync(join(d, 'src', 'new.spec.ts'), '// new\n');
    passes(lap(d));

    start(d);
    edit(join(d, 'test', 'app.test.mjs'), (s) => s.replace("test('x'", "test('renamed'"));
    rmSync(join(d, 'test', 'other.test.mjs'));
    writeFileSync(join(d, 'test', 'unit', 'new.test.mjs'), '// a file that was new before this run is now frozen\n');
    const j = lap(d);
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /test\/app\.test\.mjs \(modified\)/);
    assert.match(j.reason, /test\/other\.test\.mjs \(deleted\)/);
    assert.match(j.reason, /test\/unit\/new\.test\.mjs \(modified\)/);
  });

  test('@tests covers common layouts across languages', () => {
    const re = engine.TEST_GLOBS.map(engine.globToRegex);
    for (const f of ['test/a.js', 'packages/x/tests/b.py', 'src/__tests__/c.tsx', 'src/d.test.ts', 'e.spec.mjs',
      'pkg/foo_test.go', 'app/test_views.py', 'spec/models/user_spec.rb', 'src/test/java/FooTest.java', 'e2e/login.ts']) {
      assert.ok(re.some((r) => r.test(f)), f);
    }
    for (const f of ['src/app.ts', 'src/testing-utils.ts', 'contest.py', 'latest.go']) assert.ok(!re.some((r) => r.test(f)), f);
  });

  test('an entry that interpolates to "" is dropped, so a var can switch the guard off at start', () => {
    const fm = 'vars:\n  protect_tests: "@tests"\nprotect_existing:\n  - "{{protect_tests}}"';
    const d = repo(fm);
    start(d, 'protect_tests=');
    edit(join(d, 'test', 'app.test.mjs'), (s) => s + '// edited\n');
    passes(lap(d));
    start(d);
    edit(join(d, 'test', 'app.test.mjs'), (s) => s + '// edited again\n');
    assert.match(lap(d).reason, /test\/app\.test\.mjs \(modified\)/);
  });
});

describe('protect_json', () => {
  test('package.json#scripts: rewriting the test script fails; dependency and key-order changes pass', () => {
    const d = repo("protect_json: ['package.json#scripts']");
    start(d);
    edit(join(d, 'package.json'), (s) => {
      const p = JSON.parse(s);
      p.dependencies.a = '^2.0.0';
      p.dependencies.b = '^1.0.0';
      p.scripts = { build: p.scripts.build, test: p.scripts.test }; // reordered only
      return JSON.stringify(p, null, 4);
    });
    passes(lap(d));

    start(d);
    edit(join(d, 'package.json'), (s) => s.replace('"node --test"', '"exit 0"'));
    const j = lap(d);
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /package\.json#scripts \(modified\)/);
    assert.match(j.reason, /check command itself passed, but the guards above failed/);
  });

  test('package.json#scripts.*: new scripts allowed, existing ones frozen', () => {
    const d = repo("protect_json: ['package.json#scripts.*']");
    start(d);
    edit(join(d, 'package.json'), (s) => { const p = JSON.parse(s); p.scripts.start = 'node src/app.mjs'; return JSON.stringify(p); });
    passes(lap(d));
    start(d);
    edit(join(d, 'package.json'), (s) => { const p = JSON.parse(s); p.scripts.test = 'true'; delete p.scripts.build; return JSON.stringify(p); });
    const j = lap(d);
    assert.match(j.reason, /package\.json#scripts\.test \(modified\)/);
    assert.match(j.reason, /package\.json#scripts\.build \(deleted\)/);
  });

  test('package.json#jest: adding test-runner config inside package.json fails', () => {
    const d = repo("protect_json: ['package.json#jest']");
    start(d);
    edit(join(d, 'package.json'), (s) => { const p = JSON.parse(s); p.jest = { testPathIgnorePatterns: ['test/'] }; return JSON.stringify(p); });
    assert.match(lap(d).reason, /package\.json#jest \(added\)/);
  });

  test('a protected package.json that stops parsing fails the lap', () => {
    const d = repo("protect_json: ['package.json#scripts']");
    start(d);
    writeFileSync(join(d, 'package.json'), '{ "scripts": ');
    assert.match(lap(d).reason, /package\.json \(unreadable JSON\)/);
  });

  test('a malformed protect_json entry is rejected at start', () => {
    const d = repo("protect_json: ['package.json']");
    const r = check(d, ['start', 'g']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must look like file\.json#key/);
  });

  test('peek reports protected-value changes and new markers without using a lap', () => {
    const d = repo(`protect_json: ['package.json#scripts']\n${yamlList('forbid', ['@ts-ignore'])}`);
    start(d);
    edit(join(d, 'package.json'), (s) => s.replace('"node --test"', '"exit 0"'));
    appendFileSync(join(d, 'src', 'app.mjs'), '// @ts-ignore\n');
    const r = check(d, ['peek']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /WOULD FAIL/);
    assert.match(r.stdout, /package\.json#scripts \(modified\)/);
    assert.match(r.stdout, /Forbidden shortcuts added: src\/app\.mjs/);
  });
});
