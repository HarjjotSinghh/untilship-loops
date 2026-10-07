---
name: untilship-launch-post
description: "UntilShip loop: Launch post. You are about to announce a product, feature or release and need the post that goes out with it. Keeps working until every hard gate passes and the panel's weighted score clears the threshold; a hook checks this, not the model."
---

# Launch post (UntilShip loop)

## How this loop is enforced (read this first)

- `untilship-check` in this file means `node .untilship/bin/untilship-check.cjs`.
- Enforcement is a `stop` hook in `.cursor/hooks.json`. When the agent loop ends it runs the stop condition; if that fails, Cursor auto-submits the failing output as the next message (a follow-up), so a new turn starts.
- You cannot mark this loop done. Only the check can: `node ".untilship/loops/launch-post/score.mjs" --post "launch/post.md" --brief "launch/brief.md" --panel "launch/panel.json" --rubric ".untilship/loops/launch-post/rubric.md" --prompt ".untilship/loops/launch-post/score-prompt.md" --threshold 85 --min-words 150 --max-words 600 --require-external-judge false` (from `.untilship/loops/launch-post/loop.md`).
- Editing `.untilship/`, the hook config, or the loop's protected files fails the lap.
- `node .untilship/bin/untilship-check.cjs peek` runs the check without using a lap. `node .untilship/bin/untilship-check.cjs status` shows the lap count.
- The run ends after 6 laps as `blocked`, with a report in `.untilship/runs/<run-id>/report.md`.
- If the human tells you to stop: `node .untilship/bin/untilship-check.cjs abort "reason"`.

Draft a launch post, have it scored by a panel against a fixed rubric, rewrite, repeat.
The loop ends when the post passes every deterministic gate and the panel's weighted score
reaches the threshold (default 85/100).

**Be clear about what this is.** The gates (length, title, link, no placeholders, no hype
words) are deterministic. The score is a model's judgement against a rubric. It is a strong
editor's opinion, not a measurement of how the post will perform. The arithmetic and the
threshold live in `score.mjs`, outside the model, so the model cannot declare a pass, but a
model still does the judging.

## Trigger

You have something to announce and a place to post it (blog, X/LinkedIn long post, Product
Hunt, Hacker News "Show HN", newsletter).

## Steps

### 0. Brief (before the loop starts)

Write `launch/brief.md` and get a human yes on it. It must contain:
- **What**: the thing being launched, in one sentence.
- **Who**: the reader and the problem they have today.
- **Proof**: numbers, a demo, a customer quote, a benchmark. Only true facts.
- **Link**: the URL readers should open.
- **Channel**: where it will be posted (sets tone and length).

The brief is protected after `start`. The judges score the post against it, so inventing
claims that are not in the brief costs points.

### 1. Start

```bash
node .untilship/bin/untilship-check.cjs start launch-post
```

Optional: `--set threshold=90`, `--set max_words=300` for short channels.

### 2. Draft

Write `launch/post.md`: a `# Title` line, then the post. Lead with the reader's problem or the
result, not with "we're excited". Use one concrete proof point from the brief. End with the
link and one clear ask.

### 3. Get scored

Two ways to get the panel's scores, in order of preference:

- **External judge (independent context).** If the environment variable `UNTILSHIP_JUDGE`
  is set, `score.mjs` pipes the rubric, brief and post to that command and reads its JSON
  scores. Example: `export UNTILSHIP_JUDGE="claude -p"` (any command that reads a prompt on
  stdin and prints text containing the JSON works: `codex exec -`, `cursor-agent -p`, a local
  model). You do nothing; the check calls it.
- **Self-run panel (fallback).** If no judge is configured, spawn three fresh-context
  reviewers (subagents) that have not seen your drafting. Give each one
  `.untilship/loops/launch-post/score-prompt.md`, the rubric, the brief and the post, and
  have them return the JSON. Write the three results to `launch/panel.json` as
  `{"post_sha256": "<sha256 of post.md>", "judges": [ ...their JSON... ]}`. Get the hash
  with `node .untilship/loops/launch-post/score.mjs --hash launch/post.md`.
  The report marks these runs as **self-judged**. Never write or edit scores yourself.

### 4. Rewrite

Read the lowest-scoring criteria and the judges' notes. Rewrite the post to fix them, not to
game them. Then end your turn; the Stop hook re-scores.

## Stop when

`score.mjs` exits 0: all gates pass, and the mean weighted score across judges is at or
above `threshold`. With `--set require_external_judge=true`, a self-run panel never passes.

## On blocked

After 6 laps the run stops as `blocked`. On the final lap write
`.untilship/runs/<run-id>/blockers.md`: the best score reached, which criteria stayed low,
and whether the brief is the problem (often it lacks a real proof point).

## Report

`.untilship/runs/<run-id>/report.md` shows the score on every lap, so you can see the post
improve, plus which judge mode was used.
