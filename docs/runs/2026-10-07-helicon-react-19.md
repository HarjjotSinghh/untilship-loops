# Real run: React 18 → 19 in helicon (2026-10-07)

**Result: BLOCKED after 3 laps.** The agent finished the upgrade, and a stricter check run
afterwards confirms it works. The loop could not pass anyway, because of a gap in UntilShip:
`dependency-upgrade` checks the version in the root `package.json` only, and in this
npm-workspaces monorepo React is declared in the workspaces. The agent saw that the only way
to pass was to add a dependency the root does not use. It declined, wrote a blocker report and
stopped. The stall guard ended the run.

Cost: **$0.54** (API-equivalent, billed to a Claude subscription). Time: **2 min 38 s**.

Raw files: [`2026-10-07-helicon-react-19/`](2026-10-07-helicon-react-19/)

> **Honesty note.** This is one run of a task I chose, on my own repo, before launch. It is
> not a benchmark and proves nothing statistically. I'm publishing it because it is the first
> real run of the published package, and because it failed in a way worth showing.

## What was asked

Upgrade React 18 → 19 in [helicon](https://github.com/HarjjotSinghh/helicon) (an npm-workspaces
TypeScript monorepo), in `@helicon/ui` and `@helicon/web`: `react`, `react-dom`, `@types/react`,
`@types/react-dom`. Base commit `fb92275` (release 0.21.2).

## Exact commands

Set up the way a user would. Installing UntilShip and committing it came before the agent
started:

```bash
git clone https://github.com/HarjjotSinghh/helicon && cd helicon
git checkout -b untilship/r1 fb9227569102b8bf1589b287d594c53ed2843c59
npm ci
npx -y untilship@0.1.1 pull --agent claude      # writes .claude/skills/, .claude/settings.json (Stop hook), .untilship/
git add -A && git commit -m "chore: add UntilShip loops (npx untilship@0.1.1 pull --agent claude)"
```

One headless Claude Code session, using only the project settings that `pull` wrote (no other hooks, no MCP
servers, no `git push` or `gh`), with a 60-minute wall clock:

```bash
claude -p "/untilship-dependency-upgrade package=react target=^19 (upgrade React 18 to 19 in @helicon/ui and @helicon/web: react, react-dom, @types/react, @types/react-dom)" \
  --model claude-opus-5-5 \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --setting-sources project \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disallowedTools "Bash(git push:*)" "Bash(gh:*)" \
  --max-budget-usd 15
```

The loop handles one package per run, so the other three packages were named in the prompt
text. Following the skill, the agent started the loop itself and overrode the type check,
because helicon has no root `tsconfig.json`:

```bash
node .untilship/bin/untilship-check.cjs start dependency-upgrade --set package=react --set target=^19 \
  --set typecheck="npx --no-install tsc --noEmit -p packages/ui/tsconfig.json && npx --no-install tsc --noEmit -p apps/web/tsconfig.json && npx --no-install tsc --noEmit -p apps/web/tsconfig.test.json"
```

Build (`npm run build --if-present`) and test (`npm test`) were left at the defaults.

## Environment

| | |
|---|---|
| Agent | Claude Code 2.1.289, headless (`-p`) |
| Model | `claude-opus-5-5`, default effort |
| UntilShip | `untilship@0.1.1` from npm, `untilship-check` 0.1.1 |
| Machine | Docker container, Debian bookworm, Node 22.23.3, npm 10.9.9, non-root user, no Rust toolchain, no git credentials |
| Budget caps | $15, 60 min (neither was reached) |

## What happened

**Turn 1 (before any lap, ~2 min).** The agent bumped the four packages in both workspaces.
npm had left React 18.3.1 hoisted at the root next to the new 19, which means two copies of
React. The agent found that, removed the stale lockfile entries and reinstalled, leaving one
copy of 19.3.0. It fixed the two type errors React 19 caused (`RefObject<T>` →
`RefObject<T | null>`, global `JSX.Element` → `ReactElement`). It ran the ui, web and vscode
builds, the three type checks and `npm test` (446 tests, 0 failing), committed in two steps
and wrote `blockers.md`. It said up front that the check would still fail, and why.

| Lap | What the Stop hook ran | Exit | What it said |
|---|---|---|---|
| 1 | `verify-version.mjs react ^19` | 1 | `declared=none installed=19.3.0` · "react is not declared in package.json" |
| 2 | same (re-entry, no file changes) | 1 | same, plus "2 unchanged laps in a row ends the run as blocked" |
| 3 | same (re-entry, no file changes) | 1 | **BLOCKED**: "no progress: working tree unchanged across 3 consecutive failing laps" |

Every lap stopped at the first check, so the build, type check and test checks never ran
inside the loop. If the version check had passed, the root build would have failed next:
`npm run build` also runs the desktop app's `tauri build`, which needs `cargo`, and the
container has none. The agent hit that while working, and the cargo error is in the
transcript.

What the agent said after lap 1 (from [the transcript excerpt](2026-10-07-helicon-react-19/transcript-excerpt.jsonl)):

> The only way to pass from inside the loop is to declare React in the root `package.json`,
> which adds a dependency the root doesn't use just to satisfy the checker. I won't do that
> without your go-ahead.

It listed four ways forward: restart with a narrower `--set build=...`, declare React at the
root on request, fix the checker, or abort.

## Final result

- **UntilShip:** `blocked`, 3 of 8 laps, run time 2.2 min.
  [report.md](2026-10-07-helicon-react-19/report.md), [run.json](2026-10-07-helicon-react-19/run.json),
  [blockers.md](2026-10-07-helicon-react-19/blockers.md).
- **Stop condition re-run after the session** (same commands, outside the agent): fails at
  `verify-version.mjs`, as before. [final-check.log](2026-10-07-helicon-react-19/final-check.log).
- **Stricter check for this repo**, written before the run and never shown to the agent:
  `npm ci`, every copy of the four packages is 19.x with `npm ls` clean, the CI build and test
  steps for daemon, ui, server and web, 445/445 tests, no new suppressions. All of these pass.
  Its one flag is `.untilship/.gitignore`, a file `untilship pull` added, not the agent.
  [independent-check.log](2026-10-07-helicon-react-19/independent-check.log).
- Guards: no protected file changed, no test file edited, no skip or suppression markers added.

## Diff summary

Two agent commits (`Upgrade React to 19 in @helicon/ui and @helicon/web`, then
`Fix @helicon/ui types for React 19: nullable RefObject, no global JSX namespace`):

```text
 apps/web/package.json                          |  8 +--
 package-lock.json                              | 81 +++++++++-----------------
 packages/ui/package.json                       |  8 +--
 packages/ui/src/components/sidebar/Sidebar.tsx |  4 +-
 packages/ui/src/components/ui/Toasts.tsx       |  3 +-
 5 files changed, 40 insertions(+), 64 deletions(-)
```

Full source diff (lockfile excluded): [changes.diff](2026-10-07-helicon-react-19/changes.diff).
Lockfile: react, react-dom, @types/react and @types/react-dom go to 19.3.0 and scheduler to 0.28.0.
`@types/prop-types` and `loose-envify` are removed.
[lockfile-summary.txt](2026-10-07-helicon-react-19/lockfile-summary.txt).

## Cost and time

| | |
|---|---|
| Session wall time | 158 s (2 min 38 s) |
| Loop run (start → blocked) | 2.2 min |
| Turns | 22 |
| `total_cost_usd` | $0.537 (API-equivalent; billed to the founder's Claude subscription) |

## What this run showed

- **The hook did its job.** It sent the agent back twice, with the failing command and its
  output each time. The stall guard ended the run after two laps with no file changes,
  instead of burning all 8.
- **The check was wrong for this repo, not the code.** `verify-version.mjs` reads only the
  root `package.json`, and the default `npm run build` builds every workspace, including one
  that needs Rust. In a workspaces monorepo the loop blocks on a correct upgrade unless
  someone adds a fake root dependency. Teaching `verify-version.mjs` to read workspaces is
  the fix this run points to.
- **The agent didn't game the checker.** It could have passed lap 1's check by adding
  `react` to the root `package.json`. It asked first.

## Raw files

| File | What it is |
|---|---|
| [report.md](2026-10-07-helicon-react-19/report.md) | UntilShip's own run report, unedited |
| [run.json](2026-10-07-helicon-react-19/run.json) | machine-readable run record: config, baseline hashes, every lap |
| [blockers.md](2026-10-07-helicon-react-19/blockers.md) | the agent's blocker notes |
| [final-check.log](2026-10-07-helicon-react-19/final-check.log) | the stop condition re-run after the session |
| [independent-check.log](2026-10-07-helicon-react-19/independent-check.log) | the stricter repo-specific check |
| [changes.diff](2026-10-07-helicon-react-19/changes.diff) | source and package.json diff (lockfile excluded) |
| [lockfile-summary.txt](2026-10-07-helicon-react-19/lockfile-summary.txt) | what changed in `package-lock.json` |
| [transcript-excerpt.jsonl](2026-10-07-helicon-react-19/transcript-excerpt.jsonl) | the prompt, the agent's text messages, the Stop hook feedback and the final result event. Tool calls and outputs are left out |
