// dependency-upgrade on monorepos: verify-version.mjs reads npm/pnpm workspaces, flags half-done
// upgrades and stale duplicate copies, and the engine names a missing toolchain in its reports.
// Regression for the real helicon run (docs/runs/2026-10-07-helicon-react-19.md).
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ROOT, CLI_BIN, copyFixture, hook, check, lastRun, edit, cleanup } from './helpers.mjs';
import { verify, formatResult, parsePnpmWorkspace, workspaceGlobToRegex, minOfRange } from '../loops/dependency-upgrade/verify-version.mjs';

after(cleanup);

const FIX = join(ROOT, 'test', 'fixtures');
const npmRepo = () => copyFixture(join(FIX, 'npm-workspaces'));
const pnpmRepo = () => {
  const d = copyFixture(join(FIX, 'pnpm-workspace'));
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const link = (from, to) => { mkdirSync(dirname(join(d, from)), { recursive: true }); symlinkSync(join(d, to), join(d, from), type); };
  link('packages/ui/node_modules/react', 'node_modules/.pnpm/react@19.1.0/node_modules/react');
  link('packages/web/node_modules/react', 'node_modules/.pnpm/react@19.1.0/node_modules/react');
  link('packages/web/node_modules/@acme/ui', 'packages/ui');
  link('node_modules/.pnpm/react@19.1.0/node_modules/loop', 'node_modules'); // a cycle, which the scan must not follow
  return d;
};
const pkgJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
const editJson = (file, fn) => edit(file, (s) => JSON.stringify(fn(JSON.parse(s)), null, 2));

describe('verify-version: npm workspaces', () => {
  test('declared only in workspaces (the helicon case) passes', () => {
    const d = npmRepo();
    const r = verify('react', '^19', d);
    assert.equal(r.ok, true, r.problems.join('\n'));
    assert.deepEqual(r.info.workspaces, ['apps/docs', 'apps/web', 'packages/ui']);
    assert.deepEqual(r.info.declarations.map((x) => `${x.where} ${x.field}`), [
      'apps/web/package.json dependencies', 'packages/ui/package.json dependencies', 'packages/ui/package.json peerDependencies',
    ]);
    assert.match(formatResult('react', '^19', r), /VERSION react: declared=\^19\.0\.0, \^18\.0\.0 \|\| \^19\.0\.0 installed=19\.1\.0 target=\^19\n[\s\S]*VERSION OK$/);
  });

  test('the workspaces object form ({ packages }) works too', () => {
    const d = npmRepo();
    editJson(join(d, 'package.json'), (p) => ({ ...p, workspaces: { packages: ['packages/*', 'apps/*'] } }));
    assert.equal(verify('react', '^19', d).ok, true);
  });

  test('not declared anywhere: names the workspaces it checked', () => {
    const r = verify('left-pad', '^1', npmRepo());
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /left-pad is not declared in package\.json or any of its 3 workspace\(s\) \(apps\/docs, apps\/web, packages\/ui\)/);
  });

  test('mixed majors: one workspace still on ^18 is a half-done upgrade', () => {
    const d = npmRepo();
    editJson(join(d, 'apps', 'web', 'package.json'), (p) => ({ ...p, dependencies: { ...p.dependencies, react: '^18.3.1' } }));
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1, r.problems.join('\n'));
    assert.match(r.problems[0], /^apps\/web\/package\.json still declares react@"\^18\.3\.1" in dependencies \(lowest allowed 18\.3\.1\), which does not satisfy \^19\. Bump it there too/);
    assert.match(formatResult('react', '^19', r), /OLD  declared  apps\/web\/package\.json dependencies "\^18\.3\.1"/);
  });

  test('a peer range that no longer allows the target fails; one that includes it passes', () => {
    const d = npmRepo();
    editJson(join(d, 'packages', 'ui', 'package.json'), (p) => ({ ...p, peerDependencies: { react: '^17 || ^18' } }));
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /packages\/ui\/package\.json still declares react@"\^17 \|\| \^18" in peerDependencies; no part of that range satisfies \^19/);
  });

  test('a duplicate old copy installed in a workspace fails, with its path', () => {
    const d = npmRepo();
    pkgJson(join(d, 'apps', 'web', 'node_modules', 'react', 'package.json'), { name: 'react', version: '18.3.1' });
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => p.split(':')[0]), ['installed react@18.3.1 at apps/web/node_modules/react does not satisfy ^19']);
    assert.match(r.problems[0], /npm ls react/);
  });

  test('a duplicate old copy nested inside another package fails, with its path', () => {
    const d = npmRepo();
    pkgJson(join(d, 'node_modules', '@legacy', 'charts', 'package.json'), { name: '@legacy/charts', version: '1.0.0' });
    pkgJson(join(d, 'node_modules', '@legacy', 'charts', 'node_modules', 'react', 'package.json'), { name: 'react', version: '18.2.0' });
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /installed react@18\.2\.0 at node_modules\/@legacy\/charts\/node_modules\/react does not satisfy \^19/);
    assert.equal(r.info.copies.length, 2);
  });

  test('declared but never installed fails', () => {
    const d = npmRepo();
    editJson(join(d, 'apps', 'docs', 'package.json'), (p) => ({ ...p, dependencies: { 'left-pad': '^1.3.0' } }));
    const r = verify('left-pad', '^1', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /left-pad is not installed/);
  });

  test('single-package repos behave as before', () => {
    const d = npmRepo();
    editJson(join(d, 'package.json'), (p) => ({ name: 'solo', dependencies: { react: '^18.2.0' } }));
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /package\.json still declares react@"\^18\.2\.0"/);
    assert.equal(verify('react', '^19', d).info.workspaces.length, 0);
    editJson(join(d, 'package.json'), (p) => ({ ...p, dependencies: { react: '^19.1.0' } }));
    assert.equal(verify('react', '^19', d).ok, true);
  });
});

describe('verify-version: pnpm-workspace.yaml', () => {
  test('catalog: ranges, !exclusions and symlinked store copies pass (no symlink loop)', () => {
    const d = pnpmRepo();
    const r = verify('react', '^19', d);
    assert.equal(r.ok, true, r.problems.join('\n'));
    assert.deepEqual(r.info.workspaces, ['packages/ui', 'packages/web'], 'packages/legacy is excluded by !packages/legacy');
    assert.deepEqual(r.info.declarations.map((x) => `${x.where} ${x.raw}=${x.range}`), [
      'packages/ui/package.json catalog:=^19.0.0', 'packages/web/package.json ^19.1.0=^19.1.0',
    ]);
    assert.deepEqual(r.info.copies, [{ path: 'node_modules/.pnpm/react@19.1.0/node_modules/react', version: '19.1.0' }]);
  });

  test('a named catalog still on the old major fails', () => {
    const d = pnpmRepo();
    editJson(join(d, 'packages', 'ui', 'package.json'), (p) => ({ ...p, dependencies: { react: 'catalog:old' } }));
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /packages\/ui\/package\.json still declares react@"\^18\.2\.0" \(via catalog:old\) in dependencies/);
  });

  test('a stale store entry for the old version fails, with its path', () => {
    const d = pnpmRepo();
    pkgJson(join(d, 'node_modules', '.pnpm', 'react@18.3.1', 'node_modules', 'react', 'package.json'), { name: 'react', version: '18.3.1' });
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /installed react@18\.3\.1 at node_modules\/\.pnpm\/react@18\.3\.1\/node_modules\/react does not satisfy \^19/);
  });

  test('a workspace that depends on it but cannot resolve it fails', () => {
    const d = pnpmRepo();
    pkgJson(join(d, 'packages', 'admin', 'package.json'), { name: '@acme/admin', dependencies: { react: '^19.0.0' } });
    const r = verify('react', '^19', d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /packages\/admin\/package\.json depends on react but cannot resolve it/);
  });

  test('yaml reader: block, flush and inline lists, quoted keys, named catalogs', () => {
    const y = parsePnpmWorkspace("packages:\n- apps/*   # flush\n- 'libs/**'\ncatalog:\n  '@types/react': ^19.0.0\n  react: \"^19.1.0\"\ncatalogs:\n  react18:\n    react: ^18.3.1\n  next:\n    react: ^19.2.0\nonlyBuiltDependencies:\n  - esbuild\n");
    assert.deepEqual(y.packages, ['apps/*', 'libs/**']);
    assert.deepEqual(y.catalog, { '@types/react': '^19.0.0', react: '^19.1.0' });
    assert.deepEqual(y.catalogs, { react18: { react: '^18.3.1' }, next: { react: '^19.2.0' } });
    assert.deepEqual(parsePnpmWorkspace("packages: ['a/*', \"b\"]\n").packages, ['a/*', 'b']);
  });

  test('workspace globs: *, ** and {a,b}', () => {
    const t = (g, p) => workspaceGlobToRegex(g).test(p + '/');
    assert.ok(t('packages/*', 'packages/ui'));
    assert.ok(!t('packages/*', 'packages/ui/nested'));
    assert.ok(t('./packages/**', 'packages/a/b'));
    assert.ok(t('**/pkg-*', 'x/y/pkg-a'));
    assert.ok(t('{apps,libs}/*', 'libs/core'));
    assert.ok(!t('{apps,libs}/*', 'tools/core'));
    assert.equal(minOfRange('^18 || ^19'), '18.0.0');
    assert.equal(minOfRange('npm:react@^19.1.0'), '19.1.0');
    assert.equal(minOfRange('catalog:'), null);
  });
});

describe('dependency-upgrade loop on a monorepo', () => {
  const pull = (d) => {
    const r = spawnSync(process.execPath, [CLI_BIN, 'pull', 'dependency-upgrade', '--agent', 'claude', '--dir', d], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  };

  test('passes when react is declared only in workspaces (the helicon regression)', () => {
    const d = npmRepo();
    pull(d);
    const s = check(d, ['start', 'dependency-upgrade', '--set', 'package=react', '--set', 'target=^19',
      '--set', 'build=npm run build -w @acme/ui -w @acme/web --if-present', '--set', 'typecheck=node -e 0', '--set', 'test=node -e 0']);
    assert.equal(s.status, 0, s.stderr);
    const r = hook(d, 'claude');
    assert.match(r.json.systemMessage, /PASSED on lap 1\/8/, r.stdout);
  });

  test('a build that fails for a missing toolchain says so, and the blocked report tells the human to scope it', () => {
    const d = npmRepo();
    pull(d);
    const s = check(d, ['start', 'dependency-upgrade', '--set', 'package=react', '--set', 'target=^19',
      '--set', 'build=untilship-no-such-tool build', '--set', 'typecheck=node -e 0', '--set', 'test=node -e 0']);
    assert.equal(s.status, 0, s.stderr);
    const r1 = hook(d, 'claude');
    assert.equal(r1.json.decision, 'block');
    assert.match(r1.json.reason, /Failing check: untilship-no-such-tool build/);
    assert.match(r1.json.reason, /missing toolchain, not a code error: `untilship-no-such-tool` was not found/);
    assert.match(r1.json.reason, /--set build="<the same command, scoped/);
    hook(d, 'claude', { stop_hook_active: true });
    const r3 = hook(d, 'claude', { stop_hook_active: true });
    assert.match(r3.json.systemMessage, /BLOCKED after 3 lap/);
    const { report, run } = lastRun(d);
    assert.match(report, /\*\*Toolchain:\*\* `untilship-no-such-tool` was not found while running `untilship-no-such-tool build`\. That failure is about the environment, not the code\./);
    assert.match(report, /start a new run with --set build="/);
    assert.equal(run.laps[0].missingTool.tool, 'untilship-no-such-tool');
  });

  test('an ordinary build failure gets no toolchain hint', () => {
    const d = npmRepo();
    pull(d);
    check(d, ['start', 'dependency-upgrade', '--set', 'package=react', '--set', 'target=^19',
      '--set', 'build=node -e "process.exit(2)"', '--set', 'typecheck=node -e 0', '--set', 'test=node -e 0']);
    const r = hook(d, 'claude');
    assert.equal(r.json.decision, 'block');
    assert.doesNotMatch(r.json.reason, /toolchain/);
  });
});

