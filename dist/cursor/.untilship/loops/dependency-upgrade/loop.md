---
name: dependency-upgrade
title: Dependency upgrade
tier: Ship
type: command
trigger: A dependency or framework needs a version bump (often a major) and the bump breaks the build, the types or the tests.
stop_when: the new version is declared and installed, and the build, type check and full test suite pass on it
require_vars: [package, target]
vars:
  package: ""
  target: ""
  build: npm run build --if-present
  typecheck: npx --no-install tsc --noEmit
  test: npm test
  protect_tests: "@tests"
check:
  - node "{{loop_dir}}/verify-version.mjs" "{{package}}" "{{target}}"
  - "{{build}}"
  - "{{typecheck}}"
  - "{{test}}"
max_laps: 8
check_timeout: 1200
protect:
  - jest.config.*
  - vitest.config.*
  - vitest.workspace.*
  - playwright.config.*
  - karma.conf.*
  - .mocharc*
  - .nycrc*
  - .c8rc*
  - codecov.yml
  - tsconfig*.json
protect_existing:
  - "{{protect_tests}}"
protect_json:
  - package.json#scripts
  - package.json#jest
  - package.json#mocha
  - package.json#ava
  - package.json#nyc
  - package.json#c8
forbid:
  # test runners: skipped, focused or placeholder tests (it/test/describe/context/suite, incl. .each)
  - '\b(?:it|test|describe|context|suite|specify|bench)\.(?:skip|only|todo|skipIf|runIf)\b'
  - '\bx(?:it|test|describe|context|specify)\('
  - '\bthis\.skip\(\)'
  # type checker, linter and coverage suppressions
  - '@ts-ignore'
  - '@ts-expect-error'
  - '@ts-nocheck'
  - 'eslint-disable'
  - 'biome-ignore'
  - '\b(?:istanbul|c8|v8) ignore\b'
  # Python
  - '#\s*pragma:\s*no\s*cover'
  - '@pytest\.mark\.(?:skip|skipif|xfail)\b'
  - '\bpytest\.(?:skip|xfail)\('
  - '@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b'
  - '\.skipTest\('
  - '#\s*type:\s*ignore'
  # Go, Rust, JVM/.NET
  - '\b[tb]\.Skip(?:Now|f)?\('
  - '#\[ignore\b'
  - '@(?:Disabled|Ignore)\b'
  # npm/pnpm: running every package script through a no-op shell
  - '(?:^|\n)[ \t]*script-shell[ \t]*='
forbid_in:
  - '**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,py,rb,go,rs,java,kt,swift,vue,svelte,php,cs}'
  - '.npmrc'
---

# Dependency upgrade

Bump one dependency (or a framework major) and fix every breakage it causes. The loop ends
when the target version is really in place and build, type check and tests all pass,
checked by `untilship-check` after each of your turns.

## Trigger

Start it with the package and the version you want:

```bash
untilship-check start dependency-upgrade --set package=react --set target=^19.0.0
```

`target` accepts `19`, `19.1`, `19.1.2`, `^19.0.0`, `~19.1.0` or `>=19`.
If this repo's commands differ from the defaults, override them at start:
`--set build="pnpm build" --set typecheck="pnpm tsc --noEmit" --set test="pnpm test"`.
For a repo without TypeScript, pass `--set typecheck="node -e 0"`.

## Steps

1. Read the package's changelog and migration guide for every major between the current
   and the target version. List the breaking changes that touch this repo (search the code
   for each removed or renamed API).
2. Bump the version in `package.json` and install it with the repo's package manager
   (`npm install`, `pnpm install`, `yarn`, `bun install`). Lockfile changes are expected.
   Upgrade peer dependencies the package now requires.
3. Run the build, then the type check, then the tests. Fix the first failure, re-run,
   repeat. Use `untilship-check peek` to run the full stop condition without using a lap.
4. Fix call sites, not tests. Test files that existed at `start` are protected: editing or
   deleting one fails the lap (adding new test files is fine). If the upgrade changed the
   behaviour a test asserts on purpose, do not work around it: write it in `blockers.md`.
   A human can then restart the run with `--set protect_tests=` to allow test edits.
5. Commit in small steps: the bump, then each class of fix.
6. End your turn when you believe everything passes. The Stop hook verifies.

## Stop when

All four commands exit 0, in order:
1. `verify-version.mjs`: the declared range in `package.json` and the installed version in
   `node_modules` both satisfy `target`. A downgrade or a no-op does not pass.
2. build, 3. type check, 4. the full test suite.

Guards that also fail the lap (full list: `docs/GUARDS.md` in the UntilShip repo):
- changing test-runner config, coverage thresholds or `tsconfig*.json`;
- editing or deleting a test file that existed at `start` (new test files are allowed);
- changing `scripts` in `package.json`, or test-runner config inside it (`jest`, `mocha`,
  `ava`, `nyc`, `c8`). Dependencies and lockfiles may change;
- adding a skip, focus or suppression marker anywhere in the code: `.skip`, `.only`,
  `.todo`, `xit`/`xdescribe`/`xtest`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `istanbul`/`c8`/`v8 ignore`, `# pragma: no cover`, `pytest.skip`,
  `@pytest.mark.skip`, `t.Skip(`, `#[ignore]`, and the like. Markers already in the code
  before `start` are fine; only new ones count.

## On blocked

After 8 laps (or 2 laps with no file changes) the run stops as `blocked`. On the final lap
write `.untilship/runs/<run-id>/blockers.md`: the remaining errors, which breaking change
causes each, and options (pin a sub-dependency, wait for an upstream fix, a code change
that needs a product decision). Do not leave the repo half-upgraded without saying so.

## Report

`.untilship/runs/<run-id>/report.md` lists every lap with the failing command and its
output, so the PR description can show exactly what broke and when it went green.
