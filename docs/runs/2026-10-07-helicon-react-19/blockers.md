# Blockers: react ^19 in @helicon/ui and @helicon/web

The upgrade itself is complete and committed (2 commits on untilship/r1):
- react, react-dom 19.3.0; @types/react, @types/react-dom 19.3.0, declared in packages/ui and apps/web.
- Lockfile: one hoisted copy of React 19 (the stale hoisted 18.3.1 was removed, so there is no dual-React).
- Code fixes: `RefObject<T>` -> `RefObject<T | null>` (Sidebar.tsx), `JSX.Element` -> `ReactElement` (Toasts.tsx).
- Passing: ui, web and vscode builds; tsc on packages/ui, apps/web and apps/web tsconfig.test.json; `npm test` (446 tests, 0 failures).

The stop condition still fails, for reasons unrelated to React:

1. verify-version.mjs only reads the **root** package.json. This is an npm-workspaces monorepo and
   React is declared in the workspaces, not the root (correctly). React 19.3.0 is installed at
   node_modules/react. Options: (a) teach verify-version to check workspaces (an UntilShip change),
   (b) declare react at the root (not recommended: an artificial dependency only to satisfy the checker).
2. The root `npm run build` includes apps/desktop `tauri build`, which needs `cargo` (Rust). Rust isn't
   installed in this environment, so the build fails before and after the upgrade alike. Options: run the check
   where Rust/Tauri prerequisites exist, or restart with
   `--set build="npm run build -w @helicon/ui -w @helicon/web -w apps/vscode"`.
