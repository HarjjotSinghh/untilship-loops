---
name: idea-to-mvp
title: Idea → MVP
tier: Ship
type: command
trigger: You have a product idea and an empty (or nearly empty) repo, and you want a working first version, not a demo.
stop_when: every item in the acceptance checklist passes its own shell check
vars:
  checklist: ACCEPTANCE.md
require_files: ["{{checklist}}"]
check: node "{{loop_dir}}/checklist.mjs" "{{checklist}}"
metric: 'ACCEPTANCE: (\d+)/\d+ passed'
metric_name: items_passed
max_laps: 8
check_timeout: 900
protect:
  - "{{checklist}}"
  - jest.config.*
  - vitest.config.*
  - playwright.config.*
  - .mocharc*
protect_existing:
  - "@tests"
protect_json:
  - package.json#scripts.*
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

# Idea → MVP

Spec, scaffold and build a working first version of an idea. The loop ends when every item
on an acceptance checklist passes a shell command, checked by `untilship-check` after each
of your turns. You do not decide when it is done.

## Trigger

Use this when someone hands you an idea ("a CLI that turns a CSV of expenses into a monthly
summary", "a waitlist page with an admin export") and wants something that runs.
Do not use it for changes to an existing product; use a feature loop for that.

## Steps

### 0. Agree the checklist (before the loop starts)

1. Restate the idea in three lines: who it is for, the one job it does, what is out of scope.
2. Write `ACCEPTANCE.md` with 4 to 12 items. Each item is a behaviour a user would notice,
   followed by an indented `check:` line holding one shell command that exits 0 only when
   the behaviour works:

   ```markdown
   - [ ] `todo add "buy milk"` stores the item and prints its id
     check: node test/acceptance/add.test.mjs
   - [ ] The web page lists stored items at GET /
     check: node test/acceptance/list-page.mjs
   ```

   Rules for checks:
   - Exercise behaviour: run the CLI, start the server and request a route, run one named
     test file. Never `grep` source code for a string; that proves nothing.
   - Each check is independent, finishes in under two minutes and leaves no server running.
   - Checks may call test files that do not exist yet. They will fail until you build them,
     which is the point.
3. Show the checklist to the human and wait for an explicit yes. This is the only moment
   the checklist can change. After `start`, it is a protected file: editing it fails the lap.

### 1. Start the loop

```bash
untilship-check start idea-to-mvp
```

### 2. Spec

Write `SPEC.md` (one page): data model, the main flows, the stack and why it is the
smallest one that satisfies the checklist. Prefer the stack already in the repo.

### 3. Scaffold

Create the project skeleton, a README with run instructions, and the acceptance test files
the checklist points at. Commit.

### 4. Build, item by item

Work through the checklist top to bottom. After each item:
- run `untilship-check peek` to see which items pass (does not use a lap);
- commit with a message naming the item.

### 5. End your turn

When you believe every item passes, end your turn. The Stop hook runs the checklist. If any
item fails you get the output back and keep going.

## Stop when

`node .untilship/loops/idea-to-mvp/checklist.mjs ACCEPTANCE.md` exits 0: every item has a
check and every check exits 0. Also required (full list: `docs/GUARDS.md` in the UntilShip
repo):
- `ACCEPTANCE.md` and test-runner config are unchanged since `start`;
- test files that existed at `start` are unchanged (new test files are fine);
- `package.json` scripts that existed at `start` are unchanged (new scripts are fine), and no
  test-runner config was added to `package.json`;
- no new skip, focus or suppression marker (`.skip`, `.only`, `.todo`, `xit`, `@ts-ignore`,
  `@ts-expect-error`, `eslint-disable`, `istanbul ignore`, `# pragma: no cover`,
  `pytest.skip`, `t.Skip(`, `#[ignore]`, ...) was added.

## On blocked

After 8 laps (or 2 laps in a row with no file changes) the run stops as `blocked`.
On the final lap, write `.untilship/runs/<run-id>/blockers.md` with:
- which items still fail and the exact error;
- what you tried;
- what a human must decide (a missing credential, an ambiguous requirement, a check that is
  wrong). Do not weaken a check to get past it.

## Report

`.untilship/runs/<run-id>/report.md` records every lap: which commands ran, exit codes,
`items_passed` per lap, and the failing output. Paste its summary table into the PR.
