import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_BIN = join(ROOT, 'bin', 'untilship-check');
export const CLI_BIN = join(ROOT, 'bin', 'untilship');
const require = createRequire(import.meta.url);
export const engine = require(ENGINE_BIN);
export const cli = require(CLI_BIN);

const made = [];
export function tmp(prefix = 'untilship-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}
export function cleanup() { while (made.length) rmSync(made.pop(), { recursive: true, force: true }); }

/** Copy a fixture dir (without its solution/ overlay) to a temp dir. */
export function copyFixture(src) {
  const d = tmp();
  cpSync(src, d, { recursive: true, filter: (s) => !s.startsWith(join(src, 'solution')) });
  return d;
}

/** Copy examples/<loop> to a temp dir and install the loop for `agent` with the real CLI. */
export function installExample(loop, agent = 'claude') {
  const d = copyFixture(join(ROOT, 'examples', loop));
  const r = spawnSync(process.execPath, [CLI_BIN, 'pull', loop, '--agent', agent, '--dir', d], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pull failed: ${r.stderr}${r.stdout}`);
  return d;
}

/** Overlay examples/<loop>/solution (or a subset of its files) onto dir. */
export function overlay(loop, dir, only = null) {
  const sol = join(ROOT, 'examples', loop, 'solution');
  if (!only) { cpSync(sol, dir, { recursive: true }); return; }
  for (const f of only) cpSync(join(sol, f), join(dir, f), { recursive: true });
}

/** Run the installed (or repo) checker as the agent's hook would: JSON on stdin, JSON/text on stdout. */
export function hook(dir, agent, input = {}, { bin = null, env = {} } = {}) {
  const exe = bin || (existsSync(join(dir, '.untilship/bin/untilship-check.cjs')) ? join(dir, '.untilship/bin/untilship-check.cjs') : ENGINE_BIN);
  const payload = agent === 'cursor'
    ? { conversation_id: 'c1', generation_id: 'g1', hook_event_name: 'stop', workspace_roots: [dir], status: 'completed', loop_count: 0, ...input }
    : agent === 'codex'
      ? { session_id: 's1', turn_id: 't1', cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, ...input }
      : { session_id: 's1', cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, ...input };
  const r = spawnSync(process.execPath, [exe, 'hook', '--agent', agent], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd: dir, env: { ...process.env, UNTILSHIP_RUNNER: '', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function check(dir, args, opts = {}) {
  const exe = existsSync(join(dir, '.untilship/bin/untilship-check.cjs')) ? join(dir, '.untilship/bin/untilship-check.cjs') : ENGINE_BIN;
  return spawnSync(process.execPath, [exe, ...args, '--root', dir], { encoding: 'utf8', cwd: dir, env: { ...process.env, UNTILSHIP_RUNNER: '', ...(opts.env || {}) } });
}

export function lastRun(dir) {
  const runsDir = join(dir, '.untilship', 'runs');
  const ids = require('node:fs').readdirSync(runsDir).sort();
  const id = ids[ids.length - 1];
  return { id, run: JSON.parse(readFileSync(join(runsDir, id, 'run.json'), 'utf8')), report: readFileSync(join(runsDir, id, 'report.md'), 'utf8'), dir: join(runsDir, id) };
}

export function edit(file, fn) { writeFileSync(file, fn(readFileSync(file, 'utf8'))); }
export function write(file, s) { writeFileSync(file, s); }
