#!/usr/bin/env node
// Verifies a dependency upgrade really happened. Zero dependencies.
//
//   node verify-version.mjs <package> <target>
//
// Passes (exit 0) when:
//   - package.json declares <package> (dependencies, devDependencies, optionalDependencies
//     or peerDependencies) with a range whose minimum version satisfies <target>, and
//   - node_modules/<package>/package.json exists and its version satisfies <target>.
// If node_modules is missing entirely, it fails: an upgrade is not done until it is installed.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  const n = (s) => (s === undefined || s === 'x' || s === '*' ? null : Number(s));
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

/** Lowest version a declared range allows, e.g. "^19.1.0" -> "19.1.0", "19.x" -> "19.0.0". */
export function minOfRange(range) {
  const r = String(range).trim();
  if (/^(workspace:|file:|link:|git|https?:|npm:)/.test(r)) return null;
  const first = r.split('||')[0].trim().split(/\s+/)[0];
  const p = parseVersion(first.replace(/^(\^|~|>=|=)/, ''));
  if (!p) return null;
  return `${p.major}.${p.minor ?? 0}.${p.patch ?? 0}${p.pre ? '-' + p.pre : ''}`;
}

export function verify(pkg, target, cwd = process.cwd()) {
  const problems = [];
  const info = { declared: null, declaredMin: null, installed: null };
  const pjPath = join(cwd, 'package.json');
  if (!existsSync(pjPath)) return { ok: false, problems: ['package.json not found in ' + cwd], info };
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (pj[field] && pj[field][pkg]) { info.declared = pj[field][pkg]; info.field = field; break; }
  }
  if (!info.declared) problems.push(`${pkg} is not declared in package.json`);
  else {
    info.declaredMin = minOfRange(info.declared);
    if (!info.declaredMin) problems.push(`cannot read a version from declared range "${info.declared}"`);
    else if (!satisfies(info.declaredMin, target)) problems.push(`declared ${pkg}@"${info.declared}" (min ${info.declaredMin}) does not satisfy target ${target}`);
  }
  const instPath = join(cwd, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(instPath)) problems.push(`${pkg} is not installed (no ${join('node_modules', pkg, 'package.json')}); run the package manager install`);
  else {
    info.installed = JSON.parse(readFileSync(instPath, 'utf8')).version;
    if (!satisfies(info.installed, target)) problems.push(`installed ${pkg}@${info.installed} does not satisfy target ${target}`);
  }
  return { ok: problems.length === 0, problems, info };
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const [pkg, target] = process.argv.slice(2);
  if (!pkg || !target) { console.error('usage: verify-version.mjs <package> <target>'); process.exit(2); }
  const r = verify(pkg, target);
  console.log(`VERSION ${pkg}: declared=${r.info.declared ?? 'none'} installed=${r.info.installed ?? 'none'} target=${target}`);
  for (const p of r.problems) console.log('  - ' + p);
  console.log(r.ok ? 'VERSION OK' : 'VERSION NOT UPGRADED');
  process.exit(r.ok ? 0 : 1);
}
