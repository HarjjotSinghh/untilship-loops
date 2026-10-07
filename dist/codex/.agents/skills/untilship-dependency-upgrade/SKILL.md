---
name: untilship-dependency-upgrade
description: "UntilShip loop: Dependency upgrade. A dependency or framework needs a version bump (often a major) and the bump breaks the build, the types or the tests. Keeps working until the new version is declared and installed, and the build, type check and full test suite pass on it; a hook checks this, not the model."
---

# Dependency upgrade (UntilShip loop)

## How this loop is enforced (read this first)

- `untilship-check` in this file means `node .untilship/bin/untilship-check.cjs`.
- Enforcement is a `Stop` hook in `.codex/hooks.json`. When you end your turn it runs the stop condition; if that fails, Codex continues the turn with the failing output as a new prompt.
- You cannot mark this loop done. Only the check can: `node ".untilship/loops/dependency-upgrade/verify-version.mjs" "<package>" "<target>"` then `npm run build --if-present` then `npx --no-install tsc --noEmit` then `npm test` (from `.untilship/loops/dependency-upgrade/loop.md`).
- Editing `.untilship/`, the hook config, or the loop's protected files fails the lap.
- `node .untilship/bin/untilship-check.cjs peek` runs the check without using a lap. `node .untilship/bin/untilship-check.cjs status` shows the lap count.
- The run ends after 8 laps as `blocked`, with a report in `.untilship/runs/<run-id>/report.md`.
- If the human tells you to stop: `node .untilship/bin/untilship-check.cjs abort "reason"`.

Bump one dependency (or a framework major) and fix every breakage it causes. The loop ends
when the target version is really in place and build, type check and tests all pass,
checked by `untilship-check` after each of your turns.

## Trigger

Start it with the package and the version you want:

```bash
node .untilship/bin/untilship-check.cjs start dependency-upgrade --set package=react --set target=^19.0.0
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
   repeat. Use `node .untilship/bin/untilship-check.cjs peek` to run the full stop condition without using a lap.
4. Fix call sites, not tests. Change a test only when the behaviour it asserts was changed
   on purpose by the upgrade, and say so in the commit message.
5. Commit in small steps: the bump, then each class of fix.
6. End your turn when you believe everything passes. The Stop hook verifies.

## Stop when

All four commands exit 0, in order:
1. `verify-version.mjs`: the declared range in `package.json` and the installed version in
   `node_modules` both satisfy `target`. A downgrade or a no-op does not pass.
2. build, 3. type check, 4. the full test suite.

Guards that also fail the lap: changing test-runner config, coverage thresholds or
`tsconfig*.json`; adding `.skip`, `.only`, `@ts-ignore`, `@ts-nocheck` or `eslint-disable`
anywhere in the code.

## On blocked

After 8 laps (or 2 laps with no file changes) the run stops as `blocked`. On the final lap
write `.untilship/runs/<run-id>/blockers.md`: the remaining errors, which breaking change
causes each, and options (pin a sub-dependency, wait for an upstream fix, a code change
that needs a product decision). Do not leave the repo half-upgraded without saying so.

## Report

`.untilship/runs/<run-id>/report.md` lists every lap with the failing command and its
output, so the PR description can show exactly what broke and when it went green.
