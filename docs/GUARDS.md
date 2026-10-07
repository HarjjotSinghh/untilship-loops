# Guards: what UntilShip catches, and what it does not

A loop ends when its `check:` command exits 0. The guards below exist so the agent cannot
get there by weakening the check instead of doing the work. Any guard that trips fails the
lap, even when the check itself exited 0, and the agent is told exactly what to revert.

Everything here is decided by `untilship-check` (a script), not by the model. It compares the
repo at the end of each turn with a snapshot taken at `start`.

## 1. Always protected (every loop, cannot be turned off)

| What | Why |
|---|---|
| The loop being run: `.untilship/loops/<loop>/` (its `loop.md` is also hash-checked) | the agent cannot rewrite its own stop condition |
| The check engine: `.untilship/bin/` | the agent cannot rewrite the referee |
| The run's recorded config (`run.json`, hash-checked against `active.json`) | the check commands and limits cannot be swapped mid-run |
| Hook config: `.claude/settings.json`, `.claude/settings.local.json`, `.codex/hooks.json`, `.codex/config.toml`, `.cursor/hooks.json` | the agent cannot unhook the check |

## 2. Per-loop protections

A loop chooses its own guards in its frontmatter. Three kinds:

- **`protect:`** files that must not change, be deleted or be **added** during the run
  (adding a `jest.config.js` that skips tests counts).
- **`protect_existing:`** files that existed at `start` must not change or be deleted, but
  **new files are allowed**. `@tests` means "test files and test folders" (`test/`, `tests/`,
  `__tests__/`, `spec/`, `e2e/`, `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`,
  `*_test.go`, `*_spec.rb`, `*Test.java`, ...). So the agent may write new tests, but cannot
  weaken the ones you already had.
- **`protect_json:`** values inside a JSON file. `package.json#scripts` freezes the whole
  `scripts` block (so `"test": "jest"` cannot become `"test": "exit 0"`).
  `package.json#scripts.*` freezes each script that existed at `start` and allows new ones.
  A key that did not exist at `start` (for example a `jest` block in `package.json`) may not
  be added either. Reordering keys or reformatting the file is fine.

When a loop sets no `protect:` at all, it gets the defaults: test-runner config
(`jest.config.*`, `vitest.config.*`, `vitest.workspace.*`, `playwright.config.*`,
`karma.conf.*`, `.mocharc*`, `ava.config.*`, `pytest.ini`, `tox.ini`, `conftest.py`), coverage
thresholds (`.nycrc*`, `.c8rc*`, `codecov.yml`, `.coveragerc`) and lockfiles.

What each free loop uses:

| Loop | `protect` (no change, no add) | `protect_existing` (new files OK) | `protect_json` | Forbidden markers |
|---|---|---|---|---|
| `dependency-upgrade` | test-runner config, coverage config, `tsconfig*.json` | all test files (`@tests`) | `package.json#scripts`, and the `jest`, `mocha`, `ava`, `nyc`, `c8` keys | yes, full list below |
| `idea-to-mvp` | `ACCEPTANCE.md`, test-runner config | all test files (`@tests`) | `package.json#scripts.*` (new scripts OK), and the `jest`, `mocha`, `ava`, `nyc`, `c8` keys | yes, full list below |
| `launch-post` | the brief (`launch/brief.md`) | none | none | none (prose) |
| `aeo-setup` | none beyond section 1 | none | none | none |

`dependency-upgrade` may change `dependencies`, `devDependencies` and lockfiles: that is the
job. If an upgrade really does change behaviour a test asserts, the agent is told to stop and
say so. You can then restart with `--set protect_tests=` to allow test edits.

## 3. Forbidden markers (skip, focus and suppression comments)

The engine counts each marker per file at `start`. A lap fails only when a count **goes up**:
markers already in your code do not fail a run, new ones do (including a second copy in a file
that already had one).

| Language | Markers caught (in `dependency-upgrade` and `idea-to-mvp`) |
|---|---|
| JS / TS test runners | `it/test/describe/context/suite.skip(`, `.only(`, `.todo(`, `.skip.each`, `.only.each`, `.skipIf(`, `.runIf(`; `xit(`, `xtest(`, `xdescribe(`, `xcontext(`; `this.skip()` |
| TypeScript / lint | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` (all forms), `biome-ignore` |
| Coverage | `istanbul ignore`, `c8 ignore`, `v8 ignore`, `# pragma: no cover` |
| Python | `@pytest.mark.skip`, `@pytest.mark.skipif`, `@pytest.mark.xfail`, `pytest.skip(`, `pytest.xfail(`, `@unittest.skip*`, `@unittest.expectedFailure`, `.skipTest(`, `# type: ignore` |
| Go | `t.Skip(`, `t.Skipf(`, `t.SkipNow()` (and `b.` for benchmarks) |
| Rust | `#[ignore]`, `#[ignore = "..."]` |
| Java / Kotlin / C# | `@Disabled`, `@Ignore` |
| npm / pnpm | `script-shell=` added to `.npmrc` (would run every package script through a no-op shell) |

`.skip(` means a test-runner call (`it.skip(`, `test.skip(`, ...), not any method named
`skip`: `iter.skip(2)` in Rust is fine.

Where markers are looked for: source and test files (`.js .jsx .ts .tsx .mjs .cjs .mts .cts
.py .rb .go .rs .java .kt .swift .vue .svelte .php .cs`) plus `.npmrc`. Never in
`node_modules/`, `.git/`, `.untilship/`, virtualenvs, `target/`, or build and coverage output
(`dist/`, `build/`, `out/`, `coverage/`, `vendor/`, `.svelte-kit/`, `.output/`, `.vercel/`,
`storybook-static/`, `htmlcov/`, `*.min.js`), so a build step cannot fail a lap by emitting
comments into its output.

## 4. Stall guard

If the agent ends its turn after a failing lap without changing a single file, that lap is
marked "no change". Two of those in a row end the run as `blocked` (configurable per loop with
`stall_limit:`). This stops an agent from answering "done" over and over.

## 5. Max laps

Each loop has a lap limit (`max_laps:`, default 8; `launch-post` uses 6). When it is reached
the run ends as `blocked`. On the last lap the agent is told to write `blockers.md` (cause,
what it tried, what a human must decide), and that goes into the report.

## 6. The report

Every lap is written to `.untilship/runs/<run-id>/report.md` and `run.json`: the commands,
exit codes, output tail, which guard tripped and on which file. Read it before you merge.

## What is NOT caught

Be clear-eyed about these. You still review the diff.

- **Weak tests.** A new test that asserts very little, or a checklist check that proves little,
  passes. UntilShip guarantees the check ran and passed, not that the check is good.
  `idea-to-mvp` asks you to approve the checklist before the run for this reason.
- **Cheating inside the code itself.** For example `if (process.env.NODE_ENV === 'test') return
  expected`, a test body that returns early, an `expect(true).toBe(true)`, or a `try/catch`
  that swallows a failure. No marker list can catch these.
- **Markers not on the list,** or markers in file types and folders that are not scanned
  (shell scripts, YAML, anything in `dist/` or `vendor/`).
- **Config the loop does not protect.** For example pytest settings in `pyproject.toml` or
  `setup.cfg`, `Cargo.toml`, CI workflow files, or test-runner config keys in `package.json`
  other than `jest`, `mocha`, `ava`, `nyc` and `c8`.
- **Replacing the tools the check runs.** A fake `node_modules/.bin/tsc` or an edited package
  inside `node_modules/` is not detected (installs change `node_modules/` legitimately). A CI
  run on a clean install is the backstop.
- **Restarting the run.** The agent can run `untilship-check abort` and `start` again with
  different `--set` values (a weaker `test=` command, or `protect_tests=`). Every run, its
  vars and its abort reason stay in `.untilship/runs/`, so this shows up in review, but it is
  not blocked.
- **Editing the run state.** Hooks run with the agent's own permissions. An agent set on
  cheating could edit the baseline snapshot in `run.json`. UntilShip is a guard against an
  over-eager model, not a security boundary. For adversarial cases, run the check in CI.
- **Panel-scored loops** (`launch-post`): the gates are deterministic, the score is a model's
  opinion.
- **Windows** is untested. The hooks are plain Node, so they should work, but they have only
  been run on macOS and Linux.
