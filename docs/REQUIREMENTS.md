# Requirements and supported setups

What you need to run UntilShip loops, and what has actually been tested. If something here is
wrong for your setup, open an issue.

## You need

- **Node.js 18.17 or newer.** The CLI, the Stop hook and every loop script are plain Node with no
  dependencies (`npx untilship pull` downloads only this package).
- **One of these coding agents:**
  - **Claude Code**, with project hooks allowed. `pull` adds the loops as skills in
    `.claude/skills/` and one Stop hook entry in `.claude/settings.json` (your other hooks stay).
  - **Codex CLI**, inside a **git repo** whose project `.codex/` layer you trust. `pull` adds the
    loops to `.agents/skills/`, a Stop hook in `.codex/hooks.json` and a marked section in
    `AGENTS.md`. See [AGENT-HOOKS.md](AGENT-HOOKS.md) for why Codex needs both.
  - **Cursor**, with hooks enabled. Cursor's `stop` hook can't block a stop, so it re-prompts the
    agent instead; for strict enforcement use `npx untilship run <loop> --agent cursor`, which
    restarts the agent until the check passes or the lap limit is hit.
- **Whatever your check runs.** A loop's check is a shell command (your tests, type checker,
  build, coverage tool, `pytest`, `go test`, `cargo test` …). Those tools must be installed in the
  environment where the agent runs.
- **For judge-scored loops (optional):** an external judge set through `UNTILSHIP_JUDGE` if you
  want scoring outside the agent's session. Without one, fresh-context reviewers in the same
  session score it and the report says "self-judged".

## Tested

| | Status |
|---|---|
| macOS, Linux | Tested |
| Windows | Untested. The scripts are plain Node, so they should run; nobody has checked yet. WSL behaves like Linux. |
| npm, pnpm, yarn, bun projects | Install commands for all four are documented |
| Monorepos (npm/yarn/bun `workspaces`, `pnpm-workspace.yaml`, `lerna.json`) | Supported by `dependency-upgrade` from **0.1.2** (found by a [real run](runs/2026-10-07-helicon-react-19.md)) |
| Claude Code 2.1.289 | Used for the real run above |

## What it changes in your repo

- `pull` writes skill files, one hook entry per agent, a `.untilship/` folder (engine, loop
  scripts, run reports) and, for Codex and Cursor, a marked `AGENTS.md` section.
- `npx untilship remove` takes all of that out and leaves everything else. Run it twice safely.

## What it sends

Nothing to UntilShip. The CLI has no telemetry and makes no network calls of its own. Your agent
talks to its own AI provider as usual; an external judge, if you set one, receives the draft it
scores.
