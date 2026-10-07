#!/usr/bin/env node
/*
 * untilship-check — the stop-condition enforcer for UntilShip loops.
 *
 * Zero dependencies, CommonJS, Node >= 18. Runs as:
 *   - a Stop hook for Claude Code / Codex, or a `stop` hook for Cursor
 *     (reads the hook JSON on stdin, prints the agent-specific response)
 *   - a CLI: start | status | peek | abort | hook
 *
 * The model never decides whether the loop is done. This script does, by
 * running the loop's `check:` command(s) and reading the exit code.
 *
 * MIT License. https://github.com/untilship (repo URL set at publish time)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const VERSION = '0.1.2';
const STATE_DIR = '.untilship';
const DEFAULT_MAX_LAPS = 8;
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_STALL_LIMIT = 2;
const TAIL_CHARS = 1800;
const REPORT_TAIL_CHARS = 4000;
const LOCK_STALE_MS = 20 * 60 * 1000;

/** Files a loop may not change unless its own `protect:` list says otherwise. */
const DEFAULT_PROTECT = [
  // test runner config
  'jest.config.*', 'vitest.config.*', 'vitest.workspace.*', 'playwright.config.*',
  'karma.conf.*', '.mocharc*', 'ava.config.*', 'pytest.ini', 'tox.ini', 'conftest.py',
  // coverage thresholds
  '.nycrc*', '.c8rc*', 'codecov.yml', '.codecov.yml', '.coveragerc',
  // lockfiles
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
];

/** Always protected, whatever the loop says: the enforcement machinery itself. */
const CORE_PROTECT = [
  '.untilship/bin/**', '.untilship/loops/**',
  '.claude/settings.json', '.claude/settings.local.json',
  '.codex/hooks.json', '.codex/config.toml',
  '.cursor/hooks.json',
];

const DEFAULT_FORBID_IN = ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,py,rb,go,rs,java,kt,swift,vue,svelte,php,cs}'];

/**
 * Never scanned for forbidden patterns, whatever `forbid_in` says: build output, coverage
 * output, vendored and minified code (on top of node_modules/.git/etc., which are never walked,
 * and .untilship/). A loop can exclude more with `!glob` entries in `forbid_in`.
 */
const FORBID_EXCLUDE = [
  '**/{dist,build,out,coverage,vendor,.svelte-kit,.output,.vercel,storybook-static,htmlcov}/**',
  '**/*.min.{js,cjs,mjs}',
];

/**
 * `@tests` in `protect:` / `protect_existing:` expands to these: test files and test
 * directories across the common JS/TS, Python, Go, Ruby, JVM, .NET and Swift layouts.
 */
const TEST_GLOBS = [
  '**/{test,tests,__tests__,spec,specs,e2e,__snapshots__}/**',
  '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
  '**/{test_*.py,*_test.py,*_test.go,*_spec.rb,*_test.rb}',
  '**/{*Test,*Tests}.{java,kt,cs,swift}',
];

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'target', '.gradle', '.idea', '.vscode',
]);
const MAX_WALK_FILES = 60000;

/* ------------------------------------------------------------------ */
/* frontmatter (YAML subset)                                           */
/* ------------------------------------------------------------------ */

function parseFrontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { data: {}, body: String(text) };
  return { data: parseYamlSubset(m[1]), body: m[2] };
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function splitInlineList(inner) {
  const items = []; let cur = ''; let q = null; let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { cur += c; if (c === q && inner[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function scalar(raw) {
  const s = stripComment(String(raw).trim());
  if (s === '') return '';
  if (s[0] === '"') { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '[' && s[s.length - 1] === ']') return splitInlineList(s.slice(1, -1)).map(scalar);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function indentOf(line) { return line.match(/^ */)[0].length; }

function parseYamlSubset(src) {
  const lines = String(src).split(/\r?\n/);
  const out = {};
  let i = 0;
  const isBlank = (l) => !l.trim() || l.trim().startsWith('#');
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const km = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/);
    if (!km) throw new Error(`frontmatter line ${i + 1}: cannot parse ${JSON.stringify(line)}`);
    const key = km[1];
    const rest = (km[2] || '').trim();
    i++;
    if (/^[|>][-+]?$/.test(rest)) {
      const block = [];
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > 0)) { block.push(lines[i]); i++; }
      while (block.length && !block[block.length - 1].trim()) block.pop();
      const ind = Math.min(...block.filter((l) => l.trim()).map(indentOf), Infinity);
      const body = block.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
      out[key] = rest[0] === '|' ? body.join('\n') : body.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (rest !== '') { out[key] = scalar(rest); continue; }
    // nested: list or one-level map
    const child = [];
    while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > 0 || /^-\s/.test(lines[i]))) {
      if (!isBlank(lines[i])) child.push(lines[i]);
      i++;
    }
    if (!child.length) { out[key] = ''; continue; }
    if (/^\s*-\s/.test(child[0]) || /^\s*-$/.test(child[0])) {
      out[key] = child.map((l) => scalar(l.replace(/^\s*-\s?/, '')));
    } else {
      const obj = {};
      for (const l of child) {
        const m2 = l.trim().match(/^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/);
        if (!m2) throw new Error(`frontmatter: cannot parse nested line ${JSON.stringify(l)} under ${key}`);
        obj[m2[1]] = scalar(m2[2] || '');
      }
      out[key] = obj;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* globs + file walking                                                */
/* ------------------------------------------------------------------ */

function escapeRe(s) { return s.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }

function globToRegex(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  const anywhere = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += '(?:' + g.slice(i + 1, end).split(',').map((a) => escapeRe(a).replace(/\\\*|\*/g, '[^/]*')).join('|') + ')';
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + (anywhere ? '(?:.*/)?' : '') + re + '$');
}

function walk(root, opts = {}) {
  const out = [];
  const skipRel = opts.skipRel || [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (skipRel.some((s) => r === s || r.startsWith(s + '/'))) continue;
        stack.push(r);
      } else if (e.isFile()) {
        out.push(r);
        if (out.length >= MAX_WALK_FILES) return out.sort();
      }
    }
  }
  return out.sort();
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hashFile(abs) { try { return sha256(fs.readFileSync(abs)); } catch { return null; } }

function snapshotProtected(root, globs) {
  const res = globs.map(globToRegex);
  const files = walk(root, { skipRel: [STATE_DIR + '/runs'] });
  const snap = {};
  for (const f of files) if (res.some((r) => r.test(f))) snap[f] = hashFile(path.join(root, f));
  return snap;
}

/**
 * Compare two snapshots. With `allowAdded` (protect_existing), files that did not exist at
 * the start may appear freely; only edits to and deletions of baseline files count.
 */
function diffSnapshots(before, after, opts = {}) {
  const changed = [];
  for (const [f, h] of Object.entries(before)) {
    if (!(f in after)) changed.push({ file: f, change: 'deleted' });
    else if (after[f] !== h) changed.push({ file: f, change: 'modified' });
  }
  if (!opts.allowAdded) for (const f of Object.keys(after)) if (!(f in before)) changed.push({ file: f, change: 'added' });
  return changed.sort((a, b) => a.file.localeCompare(b.file));
}

/* protect_json: "file.json#a.b" freezes one value (adding it counts too);
 * "file.json#a.b.*" freezes each key that exists under a.b at the start, new keys allowed. */
function parseJsonSpec(spec) {
  const s = String(spec);
  const i = s.indexOf('#');
  if (i < 1 || i === s.length - 1) throw new Error(`protect_json entry "${s}" must look like file.json#key, file.json#key.sub or file.json#key.*`);
  let p = s.slice(i + 1);
  let children = false;
  if (p === '*') { children = true; p = ''; } else if (p.endsWith('.*')) { children = true; p = p.slice(0, -2); }
  return { file: s.slice(0, i), path: p ? p.split('.') : [], children, label: s.slice(0, i) + (p ? '#' + p : '') };
}

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isPlainObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function readJsonValue(root, spec) {
  const s = parseJsonSpec(spec);
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(root, s.file), 'utf8')); } catch (e) {
    return { present: false, unreadable: e.code !== 'ENOENT' };
  }
  let v = data;
  for (const k of s.path) {
    if (!isPlainObj(v) || !Object.prototype.hasOwnProperty.call(v, k)) return { present: false };
    v = v[k];
  }
  return { present: true, value: v };
}

function snapshotJson(root, specs) {
  const snap = {};
  for (const spec of specs) snap[spec] = readJsonValue(root, spec);
  return snap;
}

function diffJson(root, specs, before) {
  const changed = [];
  for (const spec of specs) {
    const s = parseJsonSpec(spec);
    const b = before[spec] || { present: false };
    const cur = readJsonValue(root, spec);
    if (cur.unreadable && b.present) { changed.push({ file: s.file, change: 'unreadable JSON' }); continue; }
    if (!s.children) {
      if (!b.present && cur.present) changed.push({ file: s.label, change: 'added' });
      else if (b.present && !cur.present) changed.push({ file: s.label, change: 'deleted' });
      else if (b.present && canon(b.value) !== canon(cur.value)) changed.push({ file: s.label, change: 'modified' });
      continue;
    }
    if (!b.present || !isPlainObj(b.value)) continue;
    const now = cur.present && isPlainObj(cur.value) ? cur.value : {};
    const prefix = s.file + '#' + (s.path.length ? s.path.join('.') + '.' : '');
    for (const k of Object.keys(b.value)) {
      if (!Object.prototype.hasOwnProperty.call(now, k)) changed.push({ file: prefix + k, change: 'deleted' });
      else if (canon(b.value[k]) !== canon(now[k])) changed.push({ file: prefix + k, change: 'modified' });
    }
  }
  return changed;
}

/** Every protected-file / protected-value change since the start of the run. */
function tamperedSince(root, run) {
  const cfg = run.config;
  const base = run.baseline;
  const out = diffSnapshots(base.protected, snapshotProtected(root, cfg.protect));
  if (cfg.protectExisting && cfg.protectExisting.length) {
    const seen = new Set(out.map((t) => t.file));
    for (const t of diffSnapshots(base.protectedExisting || {}, snapshotProtected(root, cfg.protectExisting), { allowAdded: true })) {
      if (!seen.has(t.file)) out.push(t);
    }
  }
  if (cfg.protectJson && cfg.protectJson.length) out.push(...diffJson(root, cfg.protectJson, base.protectedJson || {}));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function splitForbidIn(inGlobs) {
  const inc = [];
  const exc = FORBID_EXCLUDE.slice();
  for (const g of inGlobs) (String(g).startsWith('!') ? exc.push(String(g).slice(1)) : inc.push(String(g)));
  return { inc: inc.map(globToRegex), exc: exc.map(globToRegex) };
}

function countForbidden(root, patterns, inGlobs) {
  if (!patterns.length) return {};
  const res = patterns.map((p) => new RegExp(p, 'g'));
  const { inc, exc } = splitForbidIn(inGlobs);
  const files = walk(root, { skipRel: [STATE_DIR] }).filter((f) => inc.some((g) => g.test(f)) && !exc.some((g) => g.test(f)));
  const counts = {};
  for (const f of files) {
    let text;
    try {
      const st = fs.statSync(path.join(root, f));
      if (st.size > 1024 * 1024) continue;
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch { continue; }
    patterns.forEach((p, idx) => {
      const n = (text.match(res[idx]) || []).length;
      if (n) { counts[f] = counts[f] || {}; counts[f][p] = n; }
    });
  }
  return counts;
}

function forbiddenIncreases(before, after) {
  const hits = [];
  for (const [f, byPat] of Object.entries(after)) {
    for (const [p, n] of Object.entries(byPat)) {
      const was = (before[f] && before[f][p]) || 0;
      if (n > was) hits.push({ file: f, pattern: p, added: n - was });
    }
  }
  return hits;
}

function workingTreeFingerprint(root) {
  const git = (args) => cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.status === 0) {
    const status = git(['status', '--porcelain=v1', '-uall', '--', '.', ':(exclude).untilship']);
    const diff = git(['diff', 'HEAD', '--', '.', ':(exclude).untilship']);
    if (status.status === 0 && diff.status === 0) {
      const h = crypto.createHash('sha256').update(head.stdout).update(status.stdout).update(diff.stdout);
      for (const line of status.stdout.split('\n')) {
        if (line.startsWith('?? ')) {
          const f = line.slice(3).replace(/^"|"$/g, '');
          h.update(f).update(hashFile(path.join(root, f)) || '');
        }
      }
      return 'git:' + h.digest('hex').slice(0, 16);
    }
  }
  const h = crypto.createHash('sha256');
  for (const f of walk(root, { skipRel: [STATE_DIR] })) {
    try { const st = fs.statSync(path.join(root, f)); h.update(`${f}:${st.size}:${st.mtimeMs}\n`); } catch { /* gone */ }
  }
  return 'fs:' + h.digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* loops + state                                                       */
/* ------------------------------------------------------------------ */

function asList(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function loadLoop(loopFile) {
  const text = fs.readFileSync(loopFile, 'utf8');
  const { data, body } = parseFrontmatter(text);
  if (!data.name) throw new Error(`${loopFile}: frontmatter needs a name`);
  const checks = asList(data.check);
  if (!checks.length) throw new Error(`${loopFile}: frontmatter needs a check (a command, or a list of commands)`);
  const type = data.type || 'command';
  if (!['command', 'panel'].includes(type)) throw new Error(`${loopFile}: type must be command or panel`);
  const maxLaps = data.max_laps === undefined ? DEFAULT_MAX_LAPS : Number(data.max_laps);
  if (!Number.isInteger(maxLaps) || maxLaps < 1 || maxLaps > 100) throw new Error(`${loopFile}: max_laps must be an integer 1..100`);
  if (data.metric) { try { new RegExp(data.metric); } catch (e) { throw new Error(`${loopFile}: metric is not a valid regex: ${e.message}`); } }
  for (const p of asList(data.forbid)) { try { new RegExp(p); } catch (e) { throw new Error(`${loopFile}: forbid pattern ${p} invalid: ${e.message}`); } }
  return {
    name: String(data.name),
    title: data.title ? String(data.title) : String(data.name),
    tier: data.tier || null,
    type,
    trigger: data.trigger || null,
    stopWhen: data.stop_when || null,
    checks,
    metric: data.metric || null,
    metricName: data.metric_name || 'metric',
    maxLaps,
    timeoutS: Number(data.check_timeout || DEFAULT_TIMEOUT_S),
    stallLimit: data.stall_limit === undefined ? DEFAULT_STALL_LIMIT : Number(data.stall_limit),
    protect: data.protect === undefined ? DEFAULT_PROTECT.slice() : asList(data.protect),
    protectExisting: asList(data.protect_existing),
    protectJson: asList(data.protect_json),
    forbid: asList(data.forbid),
    forbidIn: data.forbid_in === undefined ? DEFAULT_FORBID_IN.slice() : asList(data.forbid_in),
    vars: (data.vars && typeof data.vars === 'object' && !Array.isArray(data.vars)) ? data.vars : {},
    requireVars: asList(data.require_vars),
    requireFiles: asList(data.require_files),
    body,
  };
}

function interpolate(cmd, vars) {
  return cmd.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`check references {{${k}}} but no such var is set (use vars: in loop.md or --set ${k}=...)`);
    const v = vars[k];
    return Array.isArray(v) ? v.join(',') : (v === null || v === undefined ? '' : String(v));
  });
}

function findRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE_DIR))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(startDir || process.cwd());
    dir = up;
  }
}

const P = {
  state: (root) => path.join(root, STATE_DIR),
  active: (root) => path.join(root, STATE_DIR, 'active.json'),
  lock: (root) => path.join(root, STATE_DIR, 'lock'),
  runDir: (root, id) => path.join(root, STATE_DIR, 'runs', id),
  runJson: (root, id) => path.join(root, STATE_DIR, 'runs', id, 'run.json'),
  report: (root, id) => path.join(root, STATE_DIR, 'runs', id, 'report.md'),
  blockers: (root, id) => path.join(root, STATE_DIR, 'runs', id, 'blockers.md'),
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function rel(root, abs) { return path.relative(root, abs).split(path.sep).join('/'); }
function configHash(cfg) { return sha256(JSON.stringify(cfg)).slice(0, 16); }

function resolveLoopFile(root, ref) {
  const candidates = [
    path.resolve(root, ref),
    path.resolve(root, ref, 'loop.md'),
    path.join(root, STATE_DIR, 'loops', ref, 'loop.md'),
  ];
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  throw new Error(`loop not found: ${ref} (looked in ${STATE_DIR}/loops/${ref}/loop.md)`);
}

function newRunId(name) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${name}-${crypto.randomBytes(2).toString('hex')}`;
}

function getActive(root) {
  const f = P.active(root);
  if (!fs.existsSync(f)) return null;
  const active = readJson(f);
  const run = readJson(P.runJson(root, active.runId));
  return { active, run };
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

function start(root, ref, opts = {}) {
  root = path.resolve(root);
  const existing = fs.existsSync(P.active(root)) ? readJson(P.active(root)) : null;
  if (existing && !opts.force) {
    throw new Error(`loop already active (run ${existing.runId}). Finish it, or run: untilship-check abort`);
  }
  if (existing && opts.force) abort(root, 'replaced by a new start');
  const loopFile = resolveLoopFile(root, ref);
  const loop = loadLoop(loopFile);
  const loopDir = rel(root, path.dirname(loopFile)) || '.';
  const runId = opts.runId || newRunId(loop.name);
  const vars = Object.assign({}, loop.vars, opts.vars || {}, {
    loop_dir: loopDir, run_id: runId, run_dir: `${STATE_DIR}/runs/${runId}`,
  });
  const missing = loop.requireVars.filter((k) => vars[k] === undefined || vars[k] === null || String(vars[k]).trim() === '');
  if (missing.length) throw new Error(`loop "${loop.name}" needs ${missing.map((k) => `--set ${k}=...`).join(' ')}`);
  const checks = loop.checks.map((c) => interpolate(c, vars)); // validates every {{var}} now, not mid-run
  const absent = loop.requireFiles.map((f) => interpolate(f, vars)).filter((f) => !fs.existsSync(path.join(root, f)));
  if (absent.length) throw new Error(`loop "${loop.name}" needs ${absent.join(', ')} before it can start (see the loop's step 0)`);
  // Entries are interpolated; an entry that interpolates to "" is dropped (so a var can switch
  // a guard off at start, e.g. --set protect_tests=), and "@tests" expands to TEST_GLOBS.
  const globList = (list) => list.map((p) => interpolate(p, vars).trim()).filter(Boolean)
    .flatMap((p) => (p === '@tests' ? TEST_GLOBS : [p]));
  const protectGlobs = Array.from(new Set([
    ...CORE_PROTECT, ...globList(loop.protect),
    ...(loopDir.startsWith('..') ? [] : [loopDir + '/**']),
  ]));
  const protectExisting = Array.from(new Set(globList(loop.protectExisting)));
  const protectJson = Array.from(new Set(loop.protectJson.map((p) => interpolate(p, vars).trim()).filter(Boolean)));
  protectJson.forEach(parseJsonSpec); // validate now, not mid-run
  const config = {
    name: loop.name, title: loop.title, tier: loop.tier, type: loop.type, stopWhen: loop.stopWhen,
    checks, metric: loop.metric, metricName: loop.metricName, maxLaps: loop.maxLaps, timeoutS: loop.timeoutS,
    stallLimit: loop.stallLimit, protect: protectGlobs, protectExisting, protectJson,
    forbid: loop.forbid, forbidIn: loop.forbidIn, vars,
    loopFile: rel(root, loopFile), loopSha: hashFile(loopFile),
  };
  const run = {
    version: VERSION, runId, status: 'running', agent: opts.agent || null,
    startedAt: new Date().toISOString(), endedAt: null, config,
    baseline: {
      protected: snapshotProtected(root, protectGlobs),
      protectedExisting: protectExisting.length ? snapshotProtected(root, protectExisting) : {},
      protectedJson: snapshotJson(root, protectJson),
      forbidden: countForbidden(root, loop.forbid, loop.forbidIn),
      fingerprint: workingTreeFingerprint(root),
    },
    laps: [], stalls: 0, result: null,
  };
  fs.mkdirSync(P.runDir(root, runId), { recursive: true });
  writeJson(P.runJson(root, runId), run);
  writeJson(P.active(root), { runId, startedAt: run.startedAt, configHash: configHash(config) });
  fs.writeFileSync(P.report(root, runId), reportHeader(run));
  return run;
}

/* ------------------------------------------------------------------ */
/* lap                                                                 */
/* ------------------------------------------------------------------ */

function tail(s, n) { s = String(s || ''); return s.length > n ? '…' + s.slice(s.length - n) : s; }

/**
 * Output patterns that mean "a program the check needs is not installed here", e.g.
 * `cargo` for a Tauri build. Such a failure is about the environment, not the code.
 */
const MISSING_TOOL_PATTERNS = [
  /command not found: ([A-Za-z][\w.+-]*)/, // zsh
  /(?:^|[\s:])([A-Za-z][\w.+-]*): (?:command )?not found\b/m, // sh: 1: cargo: not found / bash: cargo: command not found
  /'([A-Za-z][\w.+-]*)' is not recognized as an internal or external command/, // cmd.exe
  /\bspawn ([^\s'"]+) ENOENT\b/, // node child_process
  /failed to run (?:command )?'?([A-Za-z][\w.+-]*)\b[^\n]*?(?:No such file or directory|os error 2|program not found)/i, // e.g. tauri -> cargo
];

function detectMissingTool(output, exit) {
  const out = String(output || '');
  for (const re of MISSING_TOOL_PATTERNS) {
    const m = re.exec(out);
    if (m && m[1] && !/^\d+$/.test(m[1]) && !/(?:error|exception|warning)$/i.test(m[1])) return path.basename(m[1].replace(/\\/g, '/'));
  }
  return exit === 127 ? '(unknown: exit 127)' : null;
}

/** Which --set var produced this check command, if any (so the hint can name it). */
function varForCommand(cfg, cmd) {
  for (const [k, v] of Object.entries(cfg.vars || {})) if (typeof v === 'string' && v.trim() && v.trim() === String(cmd).trim()) return k;
  return null;
}

function toolchainHint(cfg, lap, forHuman) {
  const t = lap && lap.missingTool;
  if (!t) return null;
  const v = varForCommand(cfg, t.cmd);
  const tool = t.tool.startsWith('(') ? 'a required program' : '`' + t.tool + '`';
  const scoped = `--set ${v || '<var>'}="<the same command, scoped to the packages this change touches>"`;
  return forHuman
    ? `Toolchain: ${tool} was not found while running \`${t.cmd}\`. That failure is about the environment, not the code. Install it where the check runs, or start a new run with ${scoped} (e.g. \`npm run build -w <workspace>\`, \`pnpm --filter <pkg> build\`).`
    : `This looks like a missing toolchain, not a code error: ${tool} was not found while running \`${t.cmd}\`. You cannot change the check mid-run. If this environment cannot provide it, say so in blockers.md, so a human can install it or restart with ${scoped}.`;
}

function runChecks(root, run) {
  const cfg = run.config;
  const env = Object.assign({}, process.env, {
    UNTILSHIP: '1', UNTILSHIP_ROOT: root, UNTILSHIP_RUN_ID: run.runId,
    UNTILSHIP_RUN_DIR: path.join(root, STATE_DIR, 'runs', run.runId),
    UNTILSHIP_LAP: String(run.laps.length + 1), UNTILSHIP_LOOP: cfg.name,
  });
  const results = [];
  let stdoutAll = '';
  let stderrAll = '';
  const t0 = Date.now();
  for (const cmd of cfg.checks) {
    const t = Date.now();
    const r = cp.spawnSync(cmd, {
      cwd: root, env, shell: true, encoding: 'utf8', timeout: cfg.timeoutS * 1000,
      maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    const exit = timedOut ? 124 : (r.status === null ? 1 : r.status);
    const stdout = r.stdout || '';
    const stderr = (r.stderr || '') + (r.error && !timedOut ? `\n[untilship] ${r.error.message}` : '') +
      (timedOut ? `\n[untilship] check timed out after ${cfg.timeoutS}s` : '');
    const missingTool = exit !== 0 && !timedOut ? detectMissingTool(stdout + '\n' + stderr, exit) : null;
    results.push({ cmd, exit, durationMs: Date.now() - t, stdoutTail: tail(stdout, TAIL_CHARS), stderrTail: tail(stderr, TAIL_CHARS), ...(missingTool ? { missingTool } : {}) });
    stdoutAll += stdout;
    stderrAll += stderr;
    if (exit !== 0) break;
  }
  const failed = results.find((r) => r.exit !== 0);
  let metric = null;
  if (cfg.metric) {
    const m = new RegExp(cfg.metric, 'm').exec(stdoutAll);
    if (m) { const v = m[1] !== undefined ? m[1] : m[0]; metric = Number.isFinite(Number(v)) ? Number(v) : v; }
  }
  return {
    exitCode: failed ? failed.exit : 0, durationMs: Date.now() - t0, commands: results,
    failedCommand: failed ? failed.cmd : null, metric,
    missingTool: failed && failed.missingTool ? { tool: failed.missingTool, cmd: failed.cmd } : null,
    stdoutTail: tail(failed ? failed.stdoutTail : stdoutAll, REPORT_TAIL_CHARS),
    stderrTail: tail(failed ? failed.stderrTail : stderrAll, REPORT_TAIL_CHARS),
  };
}

function acquireLock(root) {
  const lock = P.lock(root);
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
function releaseLock(root) { try { fs.rmSync(P.lock(root), { recursive: true, force: true }); } catch { /* ignore */ } }

/**
 * Evaluate the active loop once (one lap).
 * input: the hook's stdin JSON (may be {}). Returns a decision:
 *   { action: 'allow'|'block', status, reason?, message?, lap?, report? }
 */
function evaluate(root, opts = {}) {
  root = path.resolve(root);
  const input = opts.input || {};
  const agent = opts.agent || 'none';
  if (!fs.existsSync(P.active(root))) return { action: 'allow', status: 'idle', message: null };

  if (agent === 'cursor' && input.status && input.status !== 'completed') {
    return { action: 'allow', status: 'running', message: `UntilShip: agent loop ended with status "${input.status}"; no lap recorded.` };
  }
  if (!acquireLock(root)) return { action: 'allow', status: 'running', message: 'UntilShip: another lap is being checked right now; this stop was not counted.' };
  try {
    const { active, run } = getActive(root);
    const cfg = run.config;
    const reentry = Boolean(input.stop_hook_active) || Number(input.loop_count || 0) > 0;

    // integrity of the enforcement state itself
    const integrity = [];
    if (configHash(cfg) !== active.configHash) integrity.push('run.json loop config was edited during the run');
    const loopAbs = path.join(root, cfg.loopFile);
    if (hashFile(loopAbs) !== cfg.loopSha) integrity.push(`${cfg.loopFile} was edited during the run`);

    const tampered = tamperedSince(root, run);
    const forbidden = forbiddenIncreases(run.baseline.forbidden || {}, countForbidden(root, cfg.forbid, cfg.forbidIn));
    const fingerprint = workingTreeFingerprint(root);
    const prev = run.laps[run.laps.length - 1];
    const stalled = Boolean(reentry && prev && !prev.passed && prev.fingerprint === fingerprint);
    run.stalls = stalled ? (run.stalls || 0) + 1 : 0;

    const res = runChecks(root, run);
    const guardFail = integrity.length > 0 || tampered.length > 0 || forbidden.length > 0;
    const passed = res.exitCode === 0 && !guardFail;
    const lapNo = run.laps.length + 1;
    const lap = {
      lap: lapNo, at: new Date().toISOString(), agent, stopHookActive: reentry,
      exitCode: res.exitCode, passed, durationMs: res.durationMs, metric: res.metric,
      failedCommand: res.failedCommand, commands: res.commands,
      stdoutTail: res.stdoutTail, stderrTail: res.stderrTail,
      tampered, forbidden, integrity, fingerprint, stalled,
      ...(res.missingTool ? { missingTool: res.missingTool } : {}),
    };
    run.laps.push(lap);
    if (!run.agent && agent !== 'none') run.agent = agent;

    let decision;
    if (passed) {
      run.status = 'passed';
      run.result = { status: 'passed', lap: lapNo, metric: res.metric };
    } else if (lapNo >= cfg.maxLaps) {
      run.status = 'blocked';
      run.result = { status: 'blocked', lap: lapNo, why: `max laps reached (${cfg.maxLaps})` };
    } else if (cfg.stallLimit > 0 && run.stalls >= cfg.stallLimit) {
      run.status = 'blocked';
      run.result = { status: 'blocked', lap: lapNo, why: `no progress: working tree unchanged across ${run.stalls + 1} consecutive failing laps` };
    }

    appendLapToReport(root, run, lap);
    if (run.status !== 'running') {
      run.endedAt = new Date().toISOString();
      finalizeReport(root, run);
      writeJson(P.runJson(root, run.runId), run);
      fs.rmSync(P.active(root), { force: true });
      const reportRel = `${STATE_DIR}/runs/${run.runId}/report.md`;
      const msg = run.status === 'passed'
        ? `UntilShip: "${cfg.name}" PASSED on lap ${lapNo}/${cfg.maxLaps}${res.metric !== null ? ` (${cfg.metricName}=${res.metric})` : ''}. Report: ${reportRel}`
        : `UntilShip: "${cfg.name}" BLOCKED after ${lapNo} lap(s): ${run.result.why}. Blocker report: ${reportRel}`;
      decision = { action: 'allow', status: run.status, message: msg, lap: lapNo, report: reportRel };
    } else {
      writeJson(P.runJson(root, run.runId), run);
      decision = { action: 'block', status: 'running', reason: blockReason(run, lap), lap: lapNo, report: `${STATE_DIR}/runs/${run.runId}/report.md` };
    }
    return decision;
  } finally {
    releaseLock(root);
  }
}

function blockReason(run, lap) {
  const cfg = run.config;
  const lines = [];
  lines.push(`UntilShip loop "${cfg.name}": lap ${lap.lap}/${cfg.maxLaps} did NOT pass. You are not done; the stop condition is checked by a script, not by you.`);
  if (cfg.stopWhen) lines.push(`Stop when: ${cfg.stopWhen}`);
  if (lap.integrity.length) lines.push(`Enforcement files changed: ${lap.integrity.join('; ')}. Restore them exactly.`);
  if (lap.tampered.length) {
    lines.push(`Protected files changed (revert these; the loop cannot pass while they differ from the start of the run):`);
    for (const t of lap.tampered.slice(0, 20)) lines.push(`  - ${t.file} (${t.change})`);
  }
  if (lap.forbidden.length) {
    lines.push(`Forbidden shortcuts added (remove them; fix the real problem instead):`);
    for (const f of lap.forbidden.slice(0, 20)) lines.push(`  - ${f.file}: /${f.pattern}/ x${f.added}`);
  }
  if (lap.exitCode !== 0) {
    lines.push(`Failing check: ${lap.failedCommand} (exit ${lap.exitCode})`);
    const out = [lap.stdoutTail, lap.stderrTail].filter((s) => s && s.trim()).join('\n').trim();
    if (out) lines.push('Output (tail):', tail(out, TAIL_CHARS));
    const hint = toolchainHint(cfg, lap, false);
    if (hint) lines.push(hint);
  } else if (lap.tampered.length || lap.forbidden.length || lap.integrity.length) {
    lines.push('The check command itself passed, but the guards above failed, so this lap does not count as a pass.');
  }
  if (lap.metric !== null && lap.metric !== undefined) lines.push(`${cfg.metricName}: ${lap.metric}`);
  if (lap.stalled) lines.push(`Warning: nothing in the working tree changed since the last failing lap. ${cfg.stallLimit} unchanged laps in a row ends the run as blocked.`);
  const left = cfg.maxLaps - lap.lap;
  if (left === 1) {
    lines.push(`FINAL LAP NEXT. If you cannot make the check pass, write what blocks you (cause, what you tried, what a human must decide) to ${STATE_DIR}/runs/${run.runId}/blockers.md before you end your turn.`);
  }
  lines.push('Fix the cause, then end your turn: the check re-runs automatically. Do not edit the loop, hook config, or protected files.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* reports                                                             */
/* ------------------------------------------------------------------ */

function reportHeader(run) {
  const c = run.config;
  return [
    `# UntilShip run: ${c.title}`,
    '',
    `- Run: \`${run.runId}\``,
    `- Loop: \`${c.name}\` (${c.type === 'panel' ? 'panel-scored, model-judged' : 'command-checked'}) from \`${c.loopFile}\``,
    `- Started: ${run.startedAt}`,
    c.stopWhen ? `- Stop when: ${c.stopWhen}` : null,
    `- Check: ${c.checks.map((x) => '`' + x + '`').join(' then ')}`,
    `- Max laps: ${c.maxLaps}`,
    `- Protected: ${Object.keys(run.baseline.protected).length} file(s) matching ${c.protect.length} pattern(s)`,
    c.protectExisting && c.protectExisting.length ? `- Protected as of start (new files allowed): ${Object.keys(run.baseline.protectedExisting || {}).length} file(s) matching ${c.protectExisting.length} pattern(s)` : null,
    c.protectJson && c.protectJson.length ? `- Protected JSON values: ${c.protectJson.map((x) => '`' + x + '`').join(', ')}` : null,
    c.forbid.length ? `- Forbidden in diffs: ${c.forbid.map((x) => '`/' + x + '/`').join(', ')}` : null,
    '',
    '## Laps',
    '',
  ].filter((l) => l !== null).join('\n') + '\n';
}

function fence(s) { return '```\n' + String(s).replace(/```/g, '``​`') + '\n```'; }

function appendLapToReport(root, run, lap) {
  const c = run.config;
  const head = `### Lap ${lap.lap}/${c.maxLaps}: ${lap.passed ? 'PASS' : 'FAIL'} · exit ${lap.exitCode} · ${(lap.durationMs / 1000).toFixed(1)}s` +
    (lap.metric !== null && lap.metric !== undefined ? ` · ${c.metricName}=${lap.metric}` : '') +
    (lap.stopHookActive ? ' · re-entry' : '') + (lap.stalled ? ' · no change since last lap' : '');
  const parts = [head, '', `_${lap.at}_`, ''];
  for (const cmd of lap.commands) parts.push(`- \`${cmd.cmd}\` → exit ${cmd.exit} (${(cmd.durationMs / 1000).toFixed(1)}s)`);
  if (lap.integrity.length) parts.push('', `**Integrity:** ${lap.integrity.join('; ')}`);
  if (lap.tampered.length) parts.push('', '**Protected files changed:** ' + lap.tampered.map((t) => `\`${t.file}\` (${t.change})`).join(', '));
  if (lap.forbidden.length) parts.push('', '**Forbidden patterns added:** ' + lap.forbidden.map((f) => `\`${f.file}\` /${f.pattern}/ ×${f.added}`).join(', '));
  if (!lap.passed) {
    const out = [lap.stdoutTail, lap.stderrTail].filter((s) => s && s.trim()).join('\n').trim();
    if (out) parts.push('', fence(tail(out, 1500)));
  }
  parts.push('', '');
  fs.appendFileSync(P.report(root, run.runId), parts.join('\n'));
}

function finalizeReport(root, run) {
  const c = run.config;
  const last = run.laps[run.laps.length - 1];
  const parts = [];
  const mins = ((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000).toFixed(1);
  if (run.status === 'passed') {
    parts.push(`## Result: PASSED on lap ${last.lap}/${c.maxLaps}`, '');
    parts.push(`The stop condition was met by \`${c.checks.join(' && ')}\` exiting 0, with no protected-file changes.`);
  } else if (run.status === 'blocked') {
    parts.push(`## Result: BLOCKED after ${last.lap} lap(s)`, '');
    parts.push(`Why: ${run.result.why}.`, '');
    parts.push('### Last failure', '');
    if (last.failedCommand) parts.push(`\`${last.failedCommand}\` exited ${last.exitCode}.`, '');
    const out = [last.stdoutTail, last.stderrTail].filter((s) => s && s.trim()).join('\n').trim();
    if (out) parts.push(fence(tail(out, REPORT_TAIL_CHARS)), '');
    if (last.tampered.length) parts.push('Protected files still differ from the start: ' + last.tampered.map((t) => `\`${t.file}\``).join(', '), '');
    const b = P.blockers(root, run.runId);
    parts.push('### Agent blocker notes', '');
    parts.push(fs.existsSync(b) ? fs.readFileSync(b, 'utf8').trim() : '_The agent did not write blocker notes._', '');
    parts.push('### Next step for a human', '');
    parts.push('Read the last failure above, decide whether the check or the code is wrong, then start a new run.');
    const toolLap = [...run.laps].reverse().find((l) => l.missingTool);
    const hint = toolchainHint(c, toolLap, true);
    if (hint) parts.push('', `**${hint.replace(/^Toolchain:/, 'Toolchain:**')}`);
  } else if (run.status === 'aborted') {
    parts.push(`## Result: ABORTED`, '', `Reason: ${run.result.why}`);
  }
  const metrics = run.laps.filter((l) => l.metric !== null && l.metric !== undefined).map((l) => `${l.lap}:${l.metric}`);
  parts.push('', '## Summary', '');
  parts.push(`| status | laps | duration | ${c.metricName} by lap |`, '|---|---|---|---|');
  parts.push(`| ${run.status} | ${run.laps.length}/${c.maxLaps} | ${mins} min | ${metrics.join(' → ') || 'n/a'} |`);
  if (c.type === 'panel') parts.push('', '> This loop is panel-scored. The score comes from a model judging against a rubric, not from a deterministic test. Treat it as an informed opinion; the hard gates in the check are deterministic.');
  parts.push('', `_Generated by untilship-check ${VERSION}._`, '');
  fs.appendFileSync(P.report(root, run.runId), '\n' + parts.join('\n'));
}

/* ------------------------------------------------------------------ */
/* status / abort / peek                                               */
/* ------------------------------------------------------------------ */

function status(root) {
  root = path.resolve(root);
  const a = fs.existsSync(P.active(root)) ? getActive(root) : null;
  if (!a) return { active: false };
  const { run } = a;
  return {
    active: true, runId: run.runId, loop: run.config.name, laps: run.laps.length, maxLaps: run.config.maxLaps,
    lastExit: run.laps.length ? run.laps[run.laps.length - 1].exitCode : null,
    report: `${STATE_DIR}/runs/${run.runId}/report.md`,
  };
}

function abort(root, why) {
  root = path.resolve(root);
  if (!fs.existsSync(P.active(root))) return null;
  const { run } = getActive(root);
  run.status = 'aborted';
  run.endedAt = new Date().toISOString();
  run.result = { status: 'aborted', why: why || 'aborted by user' };
  finalizeReport(root, run);
  writeJson(P.runJson(root, run.runId), run);
  fs.rmSync(P.active(root), { force: true });
  return run;
}

function peek(root) {
  root = path.resolve(root);
  if (!fs.existsSync(P.active(root))) return null;
  const { run } = getActive(root);
  const res = runChecks(root, run);
  const tampered = tamperedSince(root, run);
  const forbidden = forbiddenIncreases(run.baseline.forbidden || {}, countForbidden(root, run.config.forbid, run.config.forbidIn));
  return { exitCode: res.exitCode, metric: res.metric, failedCommand: res.failedCommand, tampered, forbidden, output: [res.stdoutTail, res.stderrTail].join('\n').trim() };
}

/* ------------------------------------------------------------------ */
/* agent adapters                                                      */
/* ------------------------------------------------------------------ */

function detectAgent(input) {
  if (!input || typeof input !== 'object') return 'none';
  if ('conversation_id' in input || 'cursor_version' in input || 'workspace_roots' in input) return 'cursor';
  if ('turn_id' in input) return 'codex';
  if (input.hook_event_name) return 'claude';
  return 'none';
}

/** Turn a decision into { stdout, exitCode } in the agent's hook protocol. */
function respond(agent, d) {
  switch (agent) {
    case 'claude':
    case 'codex': {
      // Docs: Claude Code and Codex Stop hooks accept {"decision":"block","reason":...};
      // both surface `systemMessage` to the user. Exit 0 with JSON on stdout.
      if (d.action === 'block') return { stdout: JSON.stringify({ decision: 'block', reason: d.reason }), exitCode: 0 };
      return { stdout: JSON.stringify(d.message ? { systemMessage: d.message } : {}), exitCode: 0 };
    }
    case 'cursor': {
      // Docs: Cursor's stop hook cannot veto the stop; it can auto-submit `followup_message`
      // as the next user message, which starts another agent turn.
      if (d.action === 'block') return { stdout: JSON.stringify({ followup_message: d.reason }), exitCode: 0 };
      return { stdout: JSON.stringify({}), exitCode: 0 };
    }
    default: {
      const text = d.action === 'block' ? d.reason : (d.message || 'UntilShip: no active loop.');
      const code = d.action === 'block' ? 1 : (d.status === 'blocked' ? 3 : 0);
      return { stdout: text, exitCode: code };
    }
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { _: [], set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const kv = argv[++i] || '';
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error(`--set expects key=value, got ${kv}`);
      args.set[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function hookMain(args) {
  const raw = readStdin();
  let input = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const agent = (args.agent && args.agent !== true) ? String(args.agent) : detectAgent(input);
  const startDir = args.root || input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) ||
    process.env.CLAUDE_PROJECT_DIR || process.env.CURSOR_PROJECT_DIR || process.cwd();
  const root = findRoot(startDir);
  let decision;
  if (process.env.UNTILSHIP_RUNNER === '1') {
    decision = { action: 'allow', status: 'runner', message: null }; // the headless runner counts laps itself
  } else {
    try { decision = evaluate(root, { agent, input }); } catch (e) {
      // Fail open, loudly: a broken loop config must not trap the agent forever.
      try { fs.mkdirSync(P.state(root), { recursive: true }); fs.appendFileSync(path.join(P.state(root), 'errors.log'), `${new Date().toISOString()} ${e.stack || e}\n`); } catch { /* ignore */ }
      decision = { action: 'allow', status: 'error', message: `UntilShip check failed to run: ${e.message}. Stop allowed; see .untilship/errors.log.` };
    }
  }
  const out = respond(agent, decision);
  process.stdout.write(out.stdout + (out.stdout.endsWith('\n') ? '' : '\n'));
  return out.exitCode;
}

const HELP = `untilship-check ${VERSION}: enforce a loop's stop condition outside the model.

Usage:
  untilship-check start <loop> [--set key=value ...] [--force] [--agent a]
  untilship-check hook [--agent claude|codex|cursor]   (stdin: hook JSON; default command)
  untilship-check status
  untilship-check peek        run the check now without counting a lap
  untilship-check abort [reason]
Options: --root <dir> project root (default: nearest dir containing .untilship/)
Exit codes (agent "none"): 0 passed/allowed, 1 failed (keep working), 3 blocked, 2 usage error.`;

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\n'); return 2; }
  const cmd = args._[0] || 'hook';
  if (args.help || cmd === 'help') { process.stdout.write(HELP + '\n'); return 0; }
  if (args.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (cmd === 'hook') return hookMain(args);
  const root = findRoot(args.root || process.cwd());
  try {
    if (cmd === 'start') {
      if (!args._[1]) throw new Error('start needs a loop name or path');
      const run = start(root, args._[1], { vars: args.set, force: Boolean(args.force), agent: args.agent || null });
      process.stdout.write(`UntilShip: started "${run.config.name}" (run ${run.runId}).\nStop condition: ${run.config.checks.join(' && ')}\nMax laps: ${run.config.maxLaps}. Report: ${STATE_DIR}/runs/${run.runId}/report.md\n`);
      return 0;
    }
    if (cmd === 'status') { process.stdout.write(JSON.stringify(status(root), null, 2) + '\n'); return 0; }
    if (cmd === 'peek') {
      const r = peek(root);
      if (!r) { process.stdout.write('UntilShip: no active loop.\n'); return 0; }
      const ok = r.exitCode === 0 && !r.tampered.length && !r.forbidden.length;
      process.stdout.write(`${ok ? 'WOULD PASS' : 'WOULD FAIL'} (exit ${r.exitCode}${r.metric !== null ? `, metric=${r.metric}` : ''})\n` +
        `${r.tampered.length ? 'Protected files changed: ' + r.tampered.map((t) => `${t.file} (${t.change})`).join(', ') + '\n' : ''}` +
        `${r.forbidden.length ? 'Forbidden shortcuts added: ' + r.forbidden.map((f) => `${f.file} /${f.pattern}/`).join(', ') + '\n' : ''}${r.output}\n`);
      return ok ? 0 : 1;
    }
    if (cmd === 'abort') {
      const r = abort(root, args._.slice(1).join(' ') || 'aborted by user');
      process.stdout.write(r ? `UntilShip: aborted ${r.runId}.\n` : 'UntilShip: no active loop.\n');
      return 0;
    }
    if (cmd === 'eval') { // one lap, human output (used by the headless runner and for manual demos)
      const d = evaluate(root, { agent: args.agent || 'none', input: {} });
      const out = respond('none', d);
      process.stdout.write(out.stdout + '\n');
      return out.exitCode;
    }
  } catch (e) {
    process.stderr.write(`untilship-check: ${e.message}\n`);
    return 2;
  }
  process.stderr.write(HELP + '\n');
  return 2;
}

module.exports = {
  VERSION, DEFAULT_PROTECT, CORE_PROTECT, FORBID_EXCLUDE, TEST_GLOBS, parseFrontmatter, parseYamlSubset, globToRegex,
  loadLoop, interpolate, start, evaluate, status, abort, peek, respond, detectAgent, findRoot, snapshotProtected,
  diffSnapshots, diffJson, parseJsonSpec, countForbidden, forbiddenIncreases, workingTreeFingerprint, detectMissingTool, main,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
