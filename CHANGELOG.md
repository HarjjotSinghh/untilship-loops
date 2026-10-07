# Changelog

## 0.1.2 (2026-10-07)

### Fixed

- **`dependency-upgrade` now works on monorepos.** A real run on an npm-workspaces repo
  (React 18 → 19 in helicon, [run log](docs/runs/2026-10-07-helicon-react-19.md)) ended
  `blocked` after 3 laps although the upgrade was done and every build, type check and test
  passed. `verify-version.mjs` read only the root `package.json`, so every lap said
  "react is not declared in package.json". It now:
  - reads workspaces from `package.json` (`workspaces` as an array or `{ packages }`),
    `pnpm-workspace.yaml` (with `!` exclusions and `catalog:` / `catalog:<name>` ranges) and
    `lerna.json`, and checks the root plus every workspace;
  - passes when at least one manifest declares a range that satisfies the target, and fails
    when any manifest still declares an old one (a half-done upgrade), naming the file;
  - checks every installed copy, not just `node_modules/<pkg>` at the root: each workspace's
    `node_modules`, copies nested inside other packages, and pnpm `.pnpm` store entries, without
    following symlinks. Each stale or duplicate copy is reported with its path.

### Added

- When a check fails because a program is missing (`cargo: command not found`, `spawn x ENOENT`,
  exit 127 and the like), the lap message and the blocked report say it is an environment
  problem and name the `--set` var to scope, e.g. `--set build="npm run build -w @acme/ui"`.
  The same run hit this: the root `npm run build` also ran a Tauri build that needs `cargo`.
- `loop.md` for `dependency-upgrade` explains how to pick workspace-scoped `build`, `typecheck`
  and `test` commands for npm, pnpm and turbo.

Guards are unchanged.

## 0.1.1

- `untilship remove` restores an untouched hook config byte for byte.

## 0.1.0

- First release. See the git history for details.
