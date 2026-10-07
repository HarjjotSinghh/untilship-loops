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

### Monorepos

The version check reads workspaces itself (npm/yarn/bun `workspaces`, `pnpm-workspace.yaml`,
`lerna.json`), so declare the package in the workspaces that use it, not in the root.

The default `build`, `typecheck` and `test` run at the repo root, which in a monorepo means every
workspace, including ones this upgrade does not touch and that may need a toolchain this machine
lacks (a Tauri app needs `cargo`, a mobile app needs Xcode). Before `start`, look at the root
`scripts` and pick commands scoped to the workspaces that depend on the package, plus the ones that
consume them:

- npm: `--set build="npm run build -w @acme/ui -w @acme/web"` (add `--if-present` if some lack the script)
- pnpm: `--set build="pnpm --filter @acme/ui --filter @acme/web build"` (`--filter "...@acme/ui"` adds its dependents)
- turbo: `--set build="npx turbo run build --filter=@acme/ui --filter=@acme/web"`
- no root `tsconfig.json`: `--set typecheck="npx --no-install tsc --noEmit -p packages/ui && npx --no-install tsc --noEmit -p apps/web"`

Scope to what the change can break, not to what passes. Leaving out a workspace that imports the
package hides real breakage. If a check fails because a program is missing (`cargo: command not
found`), the lap output and the blocker report say so; the commands cannot change mid-run, so write
it in `blockers.md` and a human restarts with a scoped command.

## Steps

1. Read the package's changelog and migration guide for every major between the current
   and the target version. List the breaking changes that touch this repo (search the code
   for each removed or renamed API).
2. Bump the version in every `package.json` that declares it (root and workspaces) and install
   it with the repo's package manager (`npm install`, `pnpm install`, `yarn`, `bun install`).
   Lockfile changes are expected. Upgrade peer dependencies the package now requires. If an old
   copy stays installed next to the new one, find who pulls it in (`npm ls <pkg>`,
   `pnpm why <pkg>`) and fix that, rather than leaving two copies.
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
1. `verify-version.mjs`: the root `package.json` or at least one workspace declares the package
   with a range that satisfies `target`; no manifest still declares an old range (one workspace
   left on `^18` is a half-done upgrade); and every installed copy under `node_modules` (root,
   each workspace, nested duplicates, pnpm's `.pnpm` store) satisfies `target`. Each mismatch is
   reported with its path. A downgrade or a no-op does not pass.
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
