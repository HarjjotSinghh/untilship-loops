# Agent hooks: can each agent be stopped from stopping?

UntilShip's promise is that the model cannot declare a loop finished: a script checks the
stop condition. That needs a hook that runs when the agent tries to finish and can send it
back to work. This page records what each agent's current documentation says, checked on
2026-10-07, and how UntilShip uses it.

| Agent | Hook | Can it truly block the stop? | Loop guard the agent adds | UntilShip adapter |
|---|---|---|---|---|
| Claude Code | `Stop` in `.claude/settings.json` | **Yes** | `stop_hook_active`; 8 consecutive continuations without a tool call | `{"decision":"block","reason":…}` |
| Codex CLI | `Stop` in `.codex/hooks.json` | **Yes** | `stop_hook_active` | `{"decision":"block","reason":…}` |
| Cursor | `stop` in `.cursor/hooks.json` | **No veto, but it can re-prompt.** It auto-submits a follow-up message, which starts a new agent turn | `loop_count`; `loop_limit` (default 5) | `{"followup_message":…}` with `loop_limit: null` |

Fallback for anything without a usable hook (headless CI, Cursor CLI, an agent whose hooks
are disabled): `untilship run <loop> --agent <a>`, a wrapper that re-invokes the agent
headlessly until the check passes or the lap limit is hit. See the end of this page.

---

## Claude Code

Docs: <https://code.claude.com/docs/en/hooks> (Hooks reference: "Stop decision control",
"Stop input", "Exit code 2"), <https://code.claude.com/docs/en/slash-commands> (skills).

- **Event.** `Stop` fires when the main agent finishes responding; `SubagentStop` when a
  subagent finishes. Configured under `hooks` in `.claude/settings.json` (project),
  `.claude/settings.local.json` or `~/.claude/settings.json`.
- **Blocking.** Print `{"decision": "block", "reason": "…"}` on stdout with exit 0. The docs:
  `"block"` *prevents Claude from stopping*; `reason` *tells Claude why it should continue*.
  Equivalent: exit code 2 with the reason on stderr. Omit `decision` to allow the stop.
  `hookSpecificOutput.additionalContext` also continues the turn but is labelled as feedback.
- **Input (stdin JSON).** `session_id`, `transcript_path`, `cwd`, `permission_mode`,
  `hook_event_name`, plus for Stop: `stop_hook_active`, `last_assistant_message`,
  `background_tasks`, `session_crons`.
- **Loop guard.** `stop_hook_active` is `true` when Claude is already continuing because of a
  stop hook. Claude Code also caps stop-hook continuations: *after stop hooks have continued
  the turn eight times in a row, Claude Code overrides the next block and ends the turn*. The
  count resets each time Claude calls a tool. Raise it with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
  In practice a working agent calls tools every lap, so the cap only trips on an agent that
  answers "done" over and over without doing anything, which UntilShip's stall guard catches
  first (2 unchanged laps).
- **Paths.** `${CLAUDE_PROJECT_DIR}` is the project root (rewritten correctly for PowerShell
  hooks too). `cwd` in the input follows worktrees.
- **Commands and skills.** *Custom commands have been merged into skills*:
  `.claude/commands/<name>.md` and `.claude/skills/<name>/SKILL.md` both create `/<name>`;
  old command files keep working. UntilShip ships skills with
  `disable-model-invocation: true` so a loop only starts when a human asks for it.
- **Founder config checked.** `~/.claude/settings.json` already has a `Stop` hook
  (`opsdeck-event.mjs`). Multiple Stop hooks run side by side; `untilship pull` appends its
  entry and keeps existing ones.

**Verdict: can truly block.** Honest limits: the human can always interrupt (Esc); the
8-continuation cap exists; and if the hook command itself crashes, Claude Code treats it as a
non-blocking error. UntilShip fails open in that case, with a visible message and
`.untilship/errors.log`, rather than trapping the session.

## Codex CLI

Docs: <https://developers.openai.com/codex/hooks> (sections "Where Codex looks for hooks",
"Stop", "Common output fields"), <https://developers.openai.com/codex/custom-prompts>,
<https://developers.openai.com/codex/skills> (redirects to learn.chatgpt.com/docs/build-skills).

- **Event.** `Stop` (and `SubagentStop`). Hooks live in `hooks.json` or inline `[hooks]`
  tables in `config.toml`, next to any active config layer: `~/.codex/hooks.json`,
  `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`.
  Same nested shape as Claude Code (`{"hooks": {"Stop": [{"hooks": [{"type": "command", …}]}]}}`),
  which matches `~/.codex/hooks.json` on this machine (codex-cli 0.160.1).
- **Enabled by default.** Turn off with `[features] hooks = false` (`codex_hooks` is a
  deprecated alias).
- **Blocking.** `Stop` expects JSON on stdout when it exits 0. Return
  `{"decision": "block", "reason": "…"}`. The docs: for this event `decision: "block"`
  *tells Codex to continue and automatically creates a new continuation prompt … using your
  `reason` as that prompt text*. Exit code 2 with the reason on stderr also works. If any
  Stop hook returns `continue: false`, that wins over continuation decisions.
- **Input.** Common fields include `session_id`, `transcript_path`, `cwd`, `hook_event_name`;
  Stop adds `turn_id`, `stop_hook_active`, `last_assistant_message`.
- **Output.** `systemMessage` is surfaced as a warning in the UI; we use it for the
  PASSED/BLOCKED summary.
- **Gotchas.** Commands run with the session `cwd`; the docs recommend resolving repo-local
  scripts from the git root (`$(git rev-parse --show-toplevel)`) because Codex may start in a
  subdirectory. UntilShip's Codex hook does this, so **the Codex adapter needs a git repo**.
  Project-local hooks load only when the project `.codex/` layer is trusted, and non-managed
  hooks go through Codex's trust review before they run. Default timeout is 600 s; we set
  3600 s because a lap can run a full test suite.
- **Prompts and skills.** *Custom prompts are deprecated*; they live only in
  `~/.codex/prompts/` (not shareable via the repo). Skills are the replacement and are read from
  `.agents/skills` in every directory from the cwd up to the repo root. UntilShip installs
  `.agents/skills/untilship-<loop>/SKILL.md` and adds a short marked block to `AGENTS.md`.

**Verdict: can truly block** (the stop becomes a continuation prompt). Same honest limits as
Claude Code: interrupting is always possible, trust must be granted, a crashing hook does not
block.

## Cursor

Docs: <https://cursor.com/docs/hooks> (redirect target of /docs/agent/hooks; sections
"stop", "Per-Script Configuration Options", "Configuration", "Environment Variables"),
<https://cursor.com/help/customization/skills> (commands → skills).

- **Event.** `stop` is *called when the agent loop ends*. Input: `status`
  (`"completed" | "aborted" | "error"`) and `loop_count`, plus common fields
  (`conversation_id`, `generation_id`, `workspace_roots`, `transcript_path`, …).
- **No veto.** The only output is `followup_message`: *when provided and non-empty, Cursor
  will automatically submit it as the next user message*. So Cursor cannot refuse the stop;
  the turn ends, and the hook starts a new one with the failure as the prompt. For a loop
  that is the same effect, but it is a new turn, it appears as a user message, and the human
  can stop it like any other turn.
- **Loop guard.** `loop_count` counts follow-ups already triggered. `loop_limit` (per hook
  script) defaults to **5** for Cursor hooks; `null` removes the cap. UntilShip sets
  `"loop_limit": null` so the loop's own `max_laps` (default 8) is the limit, and ignores
  `aborted`/`error` stops (no lap is counted, no follow-up is sent).
- **Locations.** Project `<root>/.cursor/hooks.json` (runs in trusted workspaces; cloud agents
  load it too), user `~/.cursor/hooks.json`, plus team/enterprise levels. All levels run; for
  `followup_message` the last response wins. Project hook paths are relative to the project
  root. Env: `CURSOR_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR` as an alias).
- **Commands and skills.** Cursor 2.4+ migrates slash commands to skills
  (`/migrate-to-skills`). Skills load from `.cursor/skills/`, `.agents/skills/`, and for
  compatibility `.claude/skills/` and `.codex/skills/`. UntilShip installs
  `.cursor/skills/untilship-<loop>/SKILL.md`.
- **Founder config checked.** `agent-setup/tools/cursor/hooks.json` uses
  `{"version": 1, "hooks": {"stop": [{"command": …, "timeout": 10}]}}`, matching the docs.

**Verdict: cannot truly block; can re-prompt.** It is enforcement by follow-up, not by veto.
The check still lives outside the model and the model still cannot mark the loop done, but a
human (or a merged higher-priority hook that returns its own `followup_message`) can end it.
**Uncertain:** the hooks page does not say whether the `cursor-agent` CLI runs project hooks.
Use `untilship run --agent cursor` there.

---

## The fallback: `untilship run`

```bash
npx untilship run dependency-upgrade --agent claude --set package=react --set target=^19
```

1. Starts the loop (same engine, same protections, same report).
2. Invokes the agent headlessly with the loop instructions:
   `claude -p --permission-mode acceptEdits`, `codex exec --sandbox workspace-write`, or
   `cursor-agent -p --force` (override with `--agent-cmd "<cmd>"`; the prompt is appended as
   the last argument).
3. When the agent exits, runs one lap. Pass → exit 0. Fail → re-invokes the agent with the
   failure as the prompt. Max laps or stall → exit 3 with the blocker report.

The runner sets `UNTILSHIP_RUNNER=1` in the agent's environment so an installed in-agent stop
hook does not count the same lap twice. This path does not depend on any hook support, so it
also works in CI.

## What none of this protects against

All three hooks run with the agent's own filesystem permissions. An agent that is determined
to cheat can edit files the hook reads. UntilShip makes the common shortcuts fail the lap
(editing the loop, the hook config, test-runner config, coverage thresholds, lockfiles,
checklists and briefs it was given, existing test files, `package.json` scripts; adding
`.skip`/`.only`/`@ts-ignore` and similar markers) and records everything in the run report,
but it is a guard against an over-eager model, not a sandbox. For adversarial settings, run
the check in CI on a clean checkout. Every guard, and what is not caught: [GUARDS.md](GUARDS.md).
