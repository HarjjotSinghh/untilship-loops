# Contributing

Thanks for helping. A few rules keep loops trustworthy.

## Adding or changing a loop

1. Create `loops/<name>/loop.md`. `name:` must match the folder. Required frontmatter:
   `name`, `title`, `tier`, `type` (`command` or `panel`), `trigger`, `stop_when`, `check`.
   Required sections: `## Trigger`, `## Steps`, `## Stop when`, `## On blocked`, `## Report`.
2. The check must be a command whose exit code means something. Prefer running real
   behaviour (tests, the CLI, an HTTP request) over grepping source. Put helper scripts next to
   `loop.md`, zero dependencies, Node >= 18.17, cross-platform (no bash-only syntax).
3. List what the agent must not touch in `protect:` and the shortcuts it must not add in
   `forbid:`.
4. Add a fixture repo in `examples/<name>/` with a `solution/` overlay, and a test in
   `test/loops.test.mjs` that drives the real hook from fail to pass and exercises one guard.
5. Run `npm run build` (regenerates `dist/`) and `npm test`. A test fails if `dist/` is stale.

## Changing the engine

`bin/untilship-check` is installed into users' repos as a single file, so it must stay
zero-dependency CommonJS. Any change to an agent's hook protocol needs a link to that agent's
current docs in `docs/AGENT-HOOKS.md`.

## Honesty

Do not describe a model-judged score as a measurement. Do not claim an agent can block
something its docs do not say it can.

Commits: small, imperative subject lines. By contributing you agree your work is MIT licensed.
