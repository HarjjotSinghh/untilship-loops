# UntilShip

Agent loops for **Claude Code, Codex and Cursor** that keep working until the job is
actually done. A loop's stop condition is checked by a script in a hook, outside the model.
The agent cannot declare success; it can only make the check pass.

The paid library launches November 2026. The first 200 on the waitlist get 50% off for life: https://untilship.com/?ref=gh

```text
you: /untilship-dependency-upgrade   (package=react, target=^19)
agent: bumps react, fixes things, ends its turn
hook:  lap 1/8 did NOT pass. Failing check: npx tsc --noEmit (exit 2) ...  -> agent keeps going
agent: fixes the types, ends its turn
hook:  lap 2/8 did NOT pass. Failing check: npm test ...                   -> agent keeps going
agent: fixes two call sites, ends its turn
hook:  PASSED on lap 3/8. Report: .untilship/runs/<run-id>/report.md        -> agent may stop
```

## What a loop is

A loop is a markdown file (`loops/<name>/loop.md`) with:

- **Trigger**: when to use it.
- **Steps**: what the agent does.
- **Stop condition**: a shell command whose exit code decides (`check:`), or for
  panel-scored loops a scoring script that applies a rubric threshold.
- **Max laps** (default 8): a lap is one check after the agent ends its turn. Hitting the
  limit stops the loop as `blocked` with a blocker report.
- **Guards**: files the agent may not touch (`protect:`), files it may not edit but may add to
  (`protect_existing:`, e.g. your existing tests), JSON values it may not change
  (`protect_json:`, e.g. `package.json#scripts`) and shortcuts it may not add (`forbid:`,
  e.g. `.skip(`, `@ts-ignore`). Every guard, and what is not caught: [docs/GUARDS.md](docs/GUARDS.md).
- **Report**: every run writes `.untilship/runs/<run-id>/report.md` and `run.json`.

```yaml
---
name: dependency-upgrade
type: command            # or: panel
check:                   # all must exit 0, in order
  - node "{{loop_dir}}/verify-version.mjs" "{{package}}" "{{target}}"
  - "{{build}}"
  - "{{typecheck}}"
  - "{{test}}"
metric: 'ACCEPTANCE: (\d+)/'   # optional regex, recorded per lap
max_laps: 8
protect: [tsconfig*.json, vitest.config.*]
protect_existing: ['@tests']          # existing tests frozen, new tests allowed
protect_json: ['package.json#scripts']
forbid: ['\b(?:it|test|describe)\.(?:skip|only)\b', '@ts-ignore']
---
```

## The four free loops

| Loop | Tier | Stops when | Checked by |
|---|---|---|---|
| [`idea-to-mvp`](loops/idea-to-mvp/loop.md) | Ship | every acceptance-checklist item passes its own shell check | `checklist.mjs` |
| [`dependency-upgrade`](loops/dependency-upgrade/loop.md) | Ship | the new version is installed and build, type check and tests pass | `verify-version.mjs` + your build/typecheck/test |
| [`launch-post`](loops/launch-post/loop.md) | Growth | hard gates pass and the panel score clears the threshold | `score.mjs` (gates are deterministic, the score is model-judged) |
| [`aeo-setup`](loops/aeo-setup/loop.md) | Growth | llms.txt, AGENTS.md, valid JSON-LD, AI-crawler-friendly robots.txt, reachable sitemap | `aeo-check.mjs` + bundled JSON-LD validator |

Every loop script is zero-dependency Node (>= 18.17).

## Install

Run in your repo (or pass `--dir /path/to/your/repo`):

```bash
npx untilship pull --agent claude                      # all free loops
npx untilship pull dependency-upgrade --agent codex
npx untilship pull aeo-setup --agent cursor
```

From a clone of this repo, `node bin/untilship ...` does the same.

What gets written into your repo:

| Agent | Loop instructions | Stop hook (merged, existing hooks kept) |
|---|---|---|
| Claude Code | `.claude/skills/untilship-<loop>/SKILL.md` (run `/untilship-<loop>`) | `Stop` in `.claude/settings.json` |
| Codex | `.agents/skills/untilship-<loop>/SKILL.md` + a marked section in `AGENTS.md` | `Stop` in `.codex/hooks.json` (needs a git repo; trust the project's hooks when Codex asks) |
| Cursor | `.cursor/skills/untilship-<loop>/SKILL.md` | `stop` in `.cursor/hooks.json` |

Plus, for all agents, `.untilship/bin/untilship-check.cjs` (the enforcer) and
`.untilship/loops/<loop>/` (the canonical loop and its scripts). Prefer copying by hand?
`dist/<agent>/` mirrors a project root; copy it and merge the `*.untilship.json` hook snippet
into your hook config.

### Uninstall

```bash
npx untilship remove                    # every agent
npx untilship remove --agent cursor     # one agent
npx untilship remove --keep-reports     # keep .untilship/runs/ (the run reports)
```

`remove` deletes the `untilship-*` skill folders, takes only UntilShip's entry out of the
hook config (your other hooks and settings stay; the file is deleted only if UntilShip
created it and nothing else is left), removes the marked UntilShip section from `AGENTS.md`
(the rest stays), and deletes `.untilship/`. It prints every path it removed. Running it
twice is safe. `pull` keeps a small record (`.untilship/install.json`) of what it created, so
`remove` can put a hook config you have not touched since back exactly as it was. When another agent still uses UntilShip, the shared `.untilship/` and
`AGENTS.md` section stay until that agent is removed too.

### Platforms

Tested on macOS and Linux. Windows is untested: the hooks and loop scripts are plain Node
(>= 18.17), so they should run, but nobody has checked yet.

## How enforcement works

1. **Start.** The skill tells the agent to run `untilship-check start <loop>`. This
   snapshots the hashes of protected files, counts forbidden patterns, and writes
   `.untilship/active.json` and `.untilship/runs/<run-id>/`.
2. **The agent ends a turn.** The agent's stop hook runs `untilship-check hook`. It runs the
   `check:` commands from the project root and records a lap: time, exit code per command,
   parsed metric, output tail, whether this was a re-entry (`stop_hook_active` /
   `loop_count`), and a working-tree fingerprint.
3. **Decision.** The lap passes only if every check exits 0 **and** no protected file changed
   **and** no forbidden pattern was added **and** the loop definition is unchanged.
   - Pass: the stop is allowed, the report gets `PASSED`, the run is closed.
   - Fail: the agent is sent back with the failing command and its output
     (Claude Code / Codex: `decision: block`; Cursor: `followup_message`).
   - Fail on the last lap, or 2 re-entries in a row with no file changes: the stop is allowed
     with status `blocked`, and the report gets the last failure plus the agent's
     `blockers.md` (it is told to write one on its final lap).
4. **Report.** `.untilship/runs/<run-id>/report.md` (human) and `run.json` (machine).
   Sample reports: [passed](docs/sample-reports/idea-to-mvp-passed.md),
   [blocked](docs/sample-reports/coverage-gate-blocked.md).

Default protected files when a loop does not set `protect:`: test-runner config
(`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `.mocharc*`, `pytest.ini`, ...),
coverage thresholds (`.nycrc*`, `.c8rc*`, `codecov.yml`, `.coveragerc`) and lockfiles.
Always protected: `.untilship/bin/`, `.untilship/loops/`, and the three agents' hook configs.
The full list per loop, the forbidden markers by language, and what is **not** caught (weak
tests, cheating inside the code, restarting a run): [docs/GUARDS.md](docs/GUARDS.md).

Commands (`node .untilship/bin/untilship-check.cjs <cmd>`):

| Command | What it does |
|---|---|
| `start <loop> [--set k=v]` | start a run; `--set` fills loop vars (e.g. `package`, `target`, `site_dir`) |
| `peek` | run the stop condition now, without using a lap |
| `status` | active run, laps used |
| `abort [reason]` | end the run as `aborted` |
| `hook [--agent a]` | what the stop hook calls (reads the hook JSON on stdin) |
| `eval` | one lap with plain-text output, for scripts and demos |

Agent-specific details, with links to each agent's docs: [docs/AGENT-HOOKS.md](docs/AGENT-HOOKS.md).

### Headless fallback

No hook, or running in CI? The runner re-invokes the agent until the check passes:

```bash
node bin/untilship run idea-to-mvp --agent claude --dir .
node bin/untilship run aeo-setup --agent codex --set site_dir=out
node bin/untilship run launch-post --agent-cmd "my-agent --yes"   # prompt appended as last arg
```

Exit codes: 0 passed, 3 blocked, 2 usage error.

## Real runs

Real runs of the published package, logged in full, including the ones that fail:

- [2026-10-07: React 18 → 19 in helicon](docs/runs/2026-10-07-helicon-react-19.md):
  `dependency-upgrade`, Claude Code, **blocked after 3 laps**, $0.54, 2.6 min. The upgrade
  itself worked. The loop could not pass because `verify-version.mjs` read only the root
  `package.json`, so a workspaces monorepo blocked. Fixed in 0.1.2 (see the
  [CHANGELOG](CHANGELOG.md)). Re-run with 0.1.2 on the same commit, with workspace-scoped
  build and type check: **passed on lap 1**, $0.26, 2.2 min
  ([re-run section](docs/runs/2026-10-07-helicon-react-19.md#re-run-with-012)).

## Honest limits

- **Cursor cannot veto a stop.** Its `stop` hook can only auto-submit a follow-up message,
  which starts a new turn. In practice it loops the same way, but a human can end it, and
  whether the `cursor-agent` CLI runs project hooks is not documented. Use `untilship run`
  there.
- **Hooks run with the agent's permissions.** UntilShip catches the usual shortcuts (editing
  the checks, thresholds, test config, existing tests, `package.json` scripts, the loop
  itself; adding `.skip`, `@ts-ignore` and the like, see [docs/GUARDS.md](docs/GUARDS.md)) and logs
  everything, but an agent determined to cheat could edit what the hook reads. It is a guard
  against an over-eager model, not a security boundary. For adversarial cases, run the check
  in CI.
- **Panel-scored loops are model-judged.** `launch-post`'s gates are deterministic, its score
  is not. The arithmetic and threshold live outside the model, and an external judge
  (`UNTILSHIP_JUDGE="claude -p"`) runs in a fresh process, but the score is still an opinion.
  Without an external judge, a fresh-context subagent panel is used and the report says
  "self-judged".
- **A check is only as good as its command.** `idea-to-mvp` asks the human to approve the
  checklist before the run because a weak check passes weak work.
- **The engine fails open.** If the hook itself crashes (for example a corrupted `run.json`)
  it allows the stop with a visible message and logs to `.untilship/errors.log`, rather than
  trapping the session.
- **Agent caps still apply.** Claude Code ends a turn after 8 consecutive stop-hook
  continuations without a tool call (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

## Repo layout

```text
bin/untilship-check        the enforcer (zero-dep CommonJS; installed as .untilship/bin/untilship-check.cjs)
bin/untilship              CLI: list, pull, remove, run, and passthrough to untilship-check
loops/<loop>/              canonical loop.md + its check scripts
scripts/build-adapters.mjs generates dist/<agent>/ from loops/ (deterministic)
dist/<agent>/              ready-to-copy adapters for claude, codex, cursor
examples/<loop>/           a tiny fixture repo per loop, with solution/ overlays (used by tests)
test/                      node:test suites
docs/                      GUARDS.md, AGENT-HOOKS.md, sample reports
```

## Develop

```bash
npm test                  # node:test, no dependencies, no network except a local HTTP server
npm run build             # regenerate dist/ after editing loops/ (a test fails if you forget)
node scripts/demo.mjs     # drive the hook by hand: one passing run, one blocked run
```

See [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
