#!/usr/bin/env node
// Verifies a dependency upgrade really happened. Zero dependencies.
//
//   node verify-version.mjs <package> <target>
//
// Works on single-package repos and on monorepos. Workspaces are read from:
//   - package.json "workspaces" (npm, yarn, bun: an array, or { packages: [...] })
//   - pnpm-workspace.yaml "packages:" (pnpm), including pnpm/bun "catalog:" ranges
//   - lerna.json "packages"
// Globs support *, **, {a,b} and !exclusions. The root and every workspace manifest are checked.
//
// Passes (exit 0) when all of these hold:
//   1. Declared: at least one manifest (root or a workspace) declares <package> in
//      dependencies, devDependencies, optionalDependencies or peerDependencies with a range
//      whose lowest version satisfies <target>.
//   2. Nothing left behind: no manifest still declares a range outside <target>
//      (one workspace on react ^18 while another is on ^19 is a half-done upgrade).
//      A peerDependencies range passes if any of its || alternatives satisfies <target>.
//   3. Installed: every copy of <package> under node_modules (the root's, each workspace's,
//      copies nested inside other packages, and pnpm's .pnpm store entries) satisfies
//      <target>, and every manifest that depends on it can resolve a copy.
// Symlinks are never followed while scanning, so pnpm and workspace links cannot loop.
import { readFileSync, existsSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const NO_DESCEND = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);
const MAX_WALK_DEPTH = 8;
const MAX_NM_DEPTH = 12;

export function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  const n = (s) => (s === undefined || s === 'x' || s === 'X' || s === '*' ? null : Number(s));
  return { major: Number(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] || null };
}

function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    const x = a[k] ?? 0; const y = b[k] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  return 0;
}

/** Does concrete version `v` satisfy `target`? Supports N, N.N, N.N.N, ^, ~, >=, >, =. */
export function satisfies(v, target) {
  const ver = parseVersion(v);
  const t = String(target).trim();
  if (!ver) return false;
  const op = (t.match(/^(\^|~|>=|>|=)?/) || [''])[0];
  const base = parseVersion(t.slice(op.length));
  if (!base) return false;
  const c = cmp(ver, base);
  switch (op) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '^':
      if (c < 0) return false;
      if (base.major > 0) return ver.major === base.major;
      if ((base.minor ?? 0) > 0) return ver.major === 0 && ver.minor === base.minor;
      return ver.major === 0 && ver.minor === 0 && ver.patch === (base.patch ?? 0);
    case '~':
      return c >= 0 && ver.major === base.major && (base.minor === null || ver.minor === base.minor);
    default: // bare or '=': partial versions act as wildcards
      if (ver.major !== base.major) return false;
      if (base.minor !== null && ver.minor !== base.minor) return false;
      if (base.patch !== null && ver.patch !== base.patch) return false;
      if (base.patch !== null && (base.pre || ver.pre)) return base.pre === ver.pre;
      return true;
  }
}

/** Strip an npm alias ("npm:react@^19") down to its range. */
function unalias(range) {
  const r = String(range).trim();
  const m = r.match(/^npm:(?:@[^/@]+\/)?[^@]+@(.+)$/);
  return m ? m[1].trim() : r;
}

function minOfAlternative(alt) {
  const first = alt.trim().split(/\s+/)[0] || '';
  const p = parseVersion(first.replace(/^(\^|~|>=|=)/, ''));
  if (!p) return null;
  return `${p.major}.${p.minor ?? 0}.${p.patch ?? 0}${p.pre ? '-' + p.pre : ''}`;
}

/** Lowest version of each || alternative, e.g. "^18 || ^19" -> ["18.0.0", "19.0.0"]; null if unreadable. */
export function alternativeMins(range) {
  const r = unalias(range);
  if (/^(workspace:|catalog:|file:|link:|portal:|patch:|git|github:|https?:|npm:)/.test(r)) return null;
  const mins = r.split('||').map(minOfAlternative);
  return mins.length && mins.every((x) => x !== null) ? mins : null;
}

/** Lowest version a declared range allows, e.g. "^19.1.0" -> "19.1.0", "19.x" -> "19.0.0", "^18 || ^19" -> "18.0.0". */
export function minOfRange(range) {
  const mins = alternativeMins(range);
  return mins ? mins.reduce((lo, x) => (cmp(parseVersion(x), parseVersion(lo)) < 0 ? x : lo)) : null;
}

/* ------------------------------------------------------------------ */
/* workspace discovery                                                 */
/* ------------------------------------------------------------------ */

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function relPath(root, abs) { const r = relative(root, abs).split(sep).join('/'); return r || '.'; }
function unquote(s) { s = String(s).trim(); return /^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s; }
function stripYamlComment(s) { return s.replace(/(^|\s)#.*$/, ''); }
const YAML_KEY = /^((?:'[^']+'|"[^"]+"|[^:\s][^:]*?)):(?:\s+(.*))?$/;

/**
 * Minimal pnpm-workspace.yaml reader: top-level `packages:` (block or inline list),
 * `catalog:` (map) and `catalogs:` (map of maps). Other keys are ignored.
 */
export function parsePnpmWorkspace(text) {
  const out = { packages: [], catalog: {}, catalogs: {} };
  let key = null; let named = null; let namedIndent = -1;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripYamlComment(raw);
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const body = line.trim();
    if (indent === 0 && key === 'packages' && body.startsWith('-')) { out.packages.push(unquote(body.slice(1))); continue; }
    if (indent === 0) {
      const m = body.match(YAML_KEY);
      key = m ? unquote(m[1]) : null; named = null; namedIndent = -1;
      if (m && key === 'packages' && (m[2] || '').trim().startsWith('[')) {
        out.packages.push(...m[2].trim().replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean));
      }
      continue;
    }
    if (key === 'packages') {
      const m = body.match(/^-\s*(.+)$/);
      if (m) out.packages.push(unquote(m[1]));
    } else if (key === 'catalog') {
      const m = body.match(YAML_KEY);
      if (m && m[2]) out.catalog[unquote(m[1])] = unquote(m[2]);
    } else if (key === 'catalogs') {
      const m = body.match(YAML_KEY);
      if (!m) continue;
      if (!m[2] || named === null || indent <= namedIndent) {
        named = unquote(m[1]); namedIndent = indent; out.catalogs[named] = out.catalogs[named] || {};
      } else out.catalogs[named][unquote(m[1])] = unquote(m[2]);
    }
  }
  return out;
}

function globSegmentRegex(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{' && seg.indexOf('}', i) > i) {
      const end = seg.indexOf('}', i);
      re += '(?:' + seg.slice(i + 1, end).split(',').map(globSegmentRegex).join('|') + ')';
      i = end;
    } else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

function globSegments(glob) { return String(glob).trim().replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter((s) => s && s !== '.'); }

/** Workspace glob -> RegExp, tested against a relative dir path with a trailing slash ("packages/ui/"). */
export function workspaceGlobToRegex(glob) {
  return new RegExp('^' + globSegments(glob).map((s) => (s === '**' ? '(?:[^/]+/)*' : globSegmentRegex(s) + '/')).join('') + '$');
}

function staticPrefix(glob) {
  const segs = globSegments(glob);
  const out = [];
  for (const s of segs) { if (/[*?{[]/.test(s)) break; out.push(s); }
  return { prefix: out.join('/'), depth: segs.includes('**') ? MAX_WALK_DEPTH : segs.length - out.length };
}

function isRealDir(abs) { try { const s = lstatSync(abs); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }

function listDirs(start, maxDepth) {
  const out = [];
  const walk = (abs, depth) => {
    out.push(abs);
    if (depth >= maxDepth) return;
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = join(abs, e.name);
      if (NO_DESCEND.has(e.name)) out.push(child); else walk(child, depth + 1);
    }
  };
  if (isRealDir(start)) walk(start, 0);
  return out;
}

/** Workspace globs from every source this repo uses, plus pnpm/bun catalogs. */
export function workspaceConfig(root) {
  const globs = []; const sources = []; let catalog = {}; let catalogs = {};
  const pj = readJson(join(root, 'package.json'));
  const ws = pj.workspaces;
  if (Array.isArray(ws)) { globs.push(...ws); sources.push('package.json workspaces'); }
  else if (ws && typeof ws === 'object') {
    if (Array.isArray(ws.packages)) { globs.push(...ws.packages); sources.push('package.json workspaces.packages'); }
    if (ws.catalog) catalog = { ...catalog, ...ws.catalog };
    if (ws.catalogs) catalogs = { ...catalogs, ...ws.catalogs };
  }
  if (pj.catalog && typeof pj.catalog === 'object') catalog = { ...catalog, ...pj.catalog };
  if (pj.catalogs && typeof pj.catalogs === 'object') catalogs = { ...catalogs, ...pj.catalogs };
  for (const f of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    if (!existsSync(join(root, f))) continue;
    const y = parsePnpmWorkspace(readFileSync(join(root, f), 'utf8'));
    globs.push(...y.packages); sources.push(f);
    catalog = { ...catalog, ...y.catalog }; catalogs = { ...catalogs, ...y.catalogs };
  }
  if (existsSync(join(root, 'lerna.json'))) {
    try { const l = readJson(join(root, 'lerna.json')); if (Array.isArray(l.packages)) { globs.push(...l.packages); sources.push('lerna.json packages'); } } catch { /* ignore */ }
  }
  return { globs: Array.from(new Set(globs.map(String))), sources, catalog, catalogs };
}

/** Absolute dirs of every workspace package (dirs with a package.json), root excluded. */
export function findWorkspaces(root, globs) {
  const include = globs.filter((g) => !g.trim().startsWith('!'));
  const exclude = globs.filter((g) => g.trim().startsWith('!')).map((g) => workspaceGlobToRegex(g.trim().slice(1)));
  const found = new Set();
  for (const g of include) {
    const re = workspaceGlobToRegex(g);
    const { prefix, depth } = staticPrefix(g);
    for (const abs of listDirs(join(root, prefix), depth)) {
      const r = relPath(root, abs);
      if (r === '.' || !re.test(r + '/') || exclude.some((x) => x.test(r + '/'))) continue;
      if (existsSync(join(abs, 'package.json'))) found.add(abs);
    }
  }
  return Array.from(found).sort();
}

/* ------------------------------------------------------------------ */
/* installed copies                                                    */
/* ------------------------------------------------------------------ */

function readVersion(pkgDir) {
  try { return readJson(join(pkgDir, 'package.json')).version || null; } catch { return null; }
}

function packageDirs(nmDir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(nmDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.isSymbolicLink() || !e.isDirectory()) continue;
    if (!e.name.startsWith('@')) { out.push([e.name, join(nmDir, e.name)]); continue; }
    try {
      for (const x of readdirSync(join(nmDir, e.name), { withFileTypes: true })) {
        if (x.isDirectory() && !x.isSymbolicLink()) out.push([`${e.name}/${x.name}`, join(nmDir, e.name, x.name)]);
      }
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * Every real (non-symlink) copy of `pkg` under `nmDir`: top level, nested node_modules of
 * other packages, and pnpm's .pnpm/<id>/node_modules/<pkg>. Symlinks are not followed.
 */
function scanNodeModules(nmDir, pkg, found, seen, depth = 0) {
  if (depth > MAX_NM_DEPTH || !isRealDir(nmDir)) return;
  const real = realpathSync(nmDir);
  if (seen.has(real)) return;
  seen.add(real);
  const store = join(nmDir, '.pnpm');
  if (isRealDir(store)) {
    let ids = [];
    try { ids = readdirSync(store); } catch { /* ignore */ }
    for (const id of ids) {
      const copy = join(store, id, 'node_modules', ...pkg.split('/'));
      if (isRealDir(copy)) found.set(realpathSync(copy), copy);
    }
  }
  for (const [name, abs] of packageDirs(nmDir)) {
    if (name === pkg) found.set(realpathSync(abs), abs);
    scanNodeModules(join(abs, 'node_modules'), pkg, found, seen, depth + 1);
  }
}

/** Node-style lookup of `pkg` from `dir` up to `root`. Links are followed here: it is what the runtime sees. */
function resolveFrom(dir, root, pkg) {
  for (let d = dir; ; d = dirname(d)) {
    const cand = join(d, 'node_modules', ...pkg.split('/'));
    if (existsSync(join(cand, 'package.json'))) return cand;
    if (resolve(d) === resolve(root) || dirname(d) === d) return null;
  }
}

/* ------------------------------------------------------------------ */
/* verify                                                              */
/* ------------------------------------------------------------------ */

export function verify(pkg, target, cwd = process.cwd()) {
  const root = resolve(cwd);
  const problems = [];
  const notes = [];
  const info = { declared: null, declaredMin: null, installed: null, declarations: [], copies: [], workspaces: [], sources: [] };
  if (!existsSync(join(root, 'package.json'))) return { ok: false, problems: ['package.json not found in ' + root], notes, info };

  let cfg;
  try { cfg = workspaceConfig(root); } catch (e) { return { ok: false, problems: [`cannot read package.json or workspace config: ${e.message}`], notes, info }; }
  const wsDirs = findWorkspaces(root, cfg.globs);
  info.sources = cfg.sources;
  info.workspaces = wsDirs.map((d) => relPath(root, d));
  if (cfg.globs.length && !wsDirs.length) notes.push(`workspaces are configured (${cfg.sources.join(', ')}: ${cfg.globs.join(', ')}) but no workspace package.json matched`);
  const manifests = [root, ...wsDirs];

  // 1 + 2: declarations, in the root and in every workspace
  for (const dir of manifests) {
    const where = relPath(root, join(dir, 'package.json'));
    let pj;
    try { pj = readJson(join(dir, 'package.json')); } catch (e) { problems.push(`${where}: cannot parse (${e.message})`); continue; }
    for (const field of DEP_FIELDS) {
      const raw = pj[field] && pj[field][pkg];
      if (raw === undefined) continue;
      let range = String(raw);
      const cat = range.match(/^catalog:(.*)$/);
      if (cat) {
        const name = cat[1].trim();
        const table = !name || name === 'default' ? cfg.catalog : (cfg.catalogs[name] || {});
        if (table[pkg] === undefined) {
          problems.push(`${where} declares ${pkg}@"${raw}" in ${field}, but no ${name && name !== 'default' ? `catalogs.${name}` : 'catalog'} entry for ${pkg} was found in pnpm-workspace.yaml or package.json.`);
          continue;
        }
        range = String(table[pkg]);
      }
      const via = range !== String(raw) ? ` (via ${raw})` : '';
      const d = { where, dir, field, raw: String(raw), range, min: minOfRange(range), status: 'ok' };
      if (d.min === null) {
        d.status = 'unread';
        notes.push(`${where} declares ${pkg}@"${raw}" in ${field}: not a registry range, so it is not version-checked (installed copies still are)`);
      } else if (field === 'peerDependencies') {
        if (!alternativeMins(range).some((m) => satisfies(m, target))) {
          d.status = 'old';
          problems.push(`${where} still declares ${pkg}@"${range}"${via} in ${field}; no part of that range satisfies ${target}. Bump or widen it, or the upgrade is half done.`);
        }
      } else if (!satisfies(d.min, target)) {
        d.status = 'old';
        problems.push(`${where} still declares ${pkg}@"${range}"${via} in ${field} (lowest allowed ${d.min}), which does not satisfy ${target}. Bump it there too, or the upgrade is half done.`);
      }
      info.declarations.push(d);
    }
  }
  const good = info.declarations.filter((d) => d.status === 'ok');
  if (!info.declarations.length) {
    const where = wsDirs.length
      ? `package.json or any of its ${wsDirs.length} workspace(s) (${info.workspaces.slice(0, 6).join(', ')}${wsDirs.length > 6 ? ', ...' : ''})`
      : `package.json${cfg.globs.length ? '' : ' (no workspaces configured in package.json, pnpm-workspace.yaml or lerna.json)'}`;
    problems.push(`${pkg} is not declared in ${where}. Declare it in the package(s) that use it.`);
  } else if (!good.length && !info.declarations.some((d) => d.status === 'old')) {
    problems.push(`no declaration of ${pkg} has a version range that can be checked against ${target}`);
  }
  const shownDecl = good[0] || info.declarations[0];
  if (shownDecl) { info.declared = shownDecl.range; info.declaredMin = shownDecl.min; }

  // 3: every installed copy reachable from the root and the workspaces
  const found = new Map(); const seen = new Set();
  for (const dir of manifests) scanNodeModules(join(dir, 'node_modules'), pkg, found, seen);
  const resolved = new Map();
  for (const dir of manifests) {
    const hit = resolveFrom(dir, root, pkg);
    if (!hit) continue;
    resolved.set(dir, hit);
    const real = realpathSync(hit);
    if (!found.has(real)) found.set(real, hit);
  }
  for (const [real, shown] of found) {
    const version = readVersion(real);
    const path = relPath(root, shown);
    info.copies.push({ path, version });
    if (!version) problems.push(`${path}/package.json has no readable version`);
    else if (!satisfies(version, target)) problems.push(`installed ${pkg}@${version} at ${path} does not satisfy ${target}: a stale or duplicate copy. Bump whatever pulls it in, dedupe, or reinstall (\`npm ls ${pkg}\` or \`pnpm why ${pkg}\` shows who needs it).`);
  }
  info.copies.sort((a, b) => a.path.localeCompare(b.path));
  if (!found.size) {
    const pnp = existsSync(join(root, '.pnp.cjs')) ? ' Yarn Plug\'n\'Play keeps no node_modules; this check needs nodeLinker: node-modules.' : '';
    problems.push(`${pkg} is not installed (no node_modules/${pkg}/package.json in the root or any workspace); run the package manager install.${pnp}`);
  } else {
    for (const d of info.declarations) {
      if (d.field === 'peerDependencies' || resolved.has(d.dir)) continue;
      problems.push(`${d.where} depends on ${pkg} but cannot resolve it (no node_modules/${pkg} in ${relPath(root, d.dir)} or above it); run the package manager install.`);
    }
  }
  const main = resolved.get(root) || (info.copies[0] ? join(root, info.copies[0].path) : null);
  info.installed = main ? readVersion(main) : null;
  return { ok: problems.length === 0, problems: Array.from(new Set(problems)), notes, info };
}

export function formatResult(pkg, target, r) {
  const uniq = (xs) => Array.from(new Set(xs.filter(Boolean)));
  const lines = [`VERSION ${pkg}: declared=${uniq(r.info.declarations.map((d) => d.range)).join(', ') || 'none'} installed=${uniq(r.info.copies.map((c) => c.version)).join(', ') || 'none'} target=${target}`];
  if (r.info.workspaces.length) lines.push(`  workspaces: ${r.info.workspaces.length} (from ${r.info.sources.join(', ')})`);
  const tag = { ok: 'ok  ', old: 'OLD ', unread: 'skip' };
  for (const d of r.info.declarations) lines.push(`  ${tag[d.status]} declared  ${d.where} ${d.field} "${d.raw}"${d.raw !== d.range ? ` = "${d.range}"` : ''}`);
  for (const c of r.info.copies) lines.push(`  ${c.version && satisfies(c.version, target) ? tag.ok : tag.old} installed ${c.path} ${c.version ?? '?'}`);
  for (const n of r.notes) lines.push('  note: ' + n);
  for (const p of r.problems) lines.push('  - ' + p);
  lines.push(r.ok ? 'VERSION OK' : 'VERSION NOT UPGRADED');
  return lines.join('\n');
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const [pkg, target] = process.argv.slice(2);
  if (!pkg || !target) { console.error('usage: verify-version.mjs <package> <target>'); process.exit(2); }
  const r = verify(pkg, target);
  console.log(formatResult(pkg, target, r));
  process.exit(r.ok ? 0 : 1);
}
