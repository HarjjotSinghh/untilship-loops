#!/usr/bin/env node
// AEO checks for the aeo-setup loop. Zero dependencies, Node >= 18.
//
//   node aeo-check.mjs --site-dir public [--base-url https://example.com] \
//     [--crawlers GPTBot,ClaudeBot,PerplexityBot] [--root .]
//
// Five checks; exit 0 only if all pass. Prints "AEO: <n>/5 checks passed".
//   1. llms.txt   present in site_dir and well-formed (llmstxt.org); reachable if base_url set
//   2. AGENTS.md  present at the repo root and substantive
//   3. JSON-LD    every ld+json block on every HTML page validates; home page has Organization/WebSite
//   4. robots.txt allows "/" for every chosen AI crawler (RFC 9309 matching)
//   5. sitemap    present (local) or reachable over HTTP (base_url) with at least one <loc>
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateText, extractJsonLdBlocks } from './jsonld-validate.mjs';

export const DEFAULT_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended'];

function result(name) { return { name, errors: [], warnings: [], info: '' }; }
function isAbsUrl(v) { try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }

/* ---------------- llms.txt ---------------- */
export function checkLlmsTxt(text) {
  const r = result('llms.txt');
  if (/<\s*(html|body|div|head)\b/i.test(text)) r.errors.push('looks like HTML; llms.txt must be plain markdown');
  const lines = text.split(/\r?\n/);
  const nonBlank = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim());
  if (!nonBlank.length) { r.errors.push('file is empty'); return r; }
  const h1s = lines.filter((l) => /^#\s+\S/.test(l));
  if (!/^#\s+\S/.test(nonBlank[0].l)) r.errors.push('first line must be "# <site or project name>"');
  if (h1s.length !== 1) r.errors.push(`exactly one "# " H1 allowed, found ${h1s.length}`);
  if (!nonBlank[1] || !/^>\s*\S/.test(nonBlank[1].l)) r.warnings.push('add a "> one-sentence summary" right after the title');
  let section = null;
  let sections = 0;
  let links = 0;
  for (const { l, i } of nonBlank) {
    if (/^##\s+\S/.test(l)) { section = l.replace(/^##\s+/, '').trim(); sections++; continue; }
    if (!section) continue;
    if (/^\s*[-*]\s/.test(l)) {
      const m = l.match(/^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?:\s*:\s*(.*))?\s*$/);
      if (!m) { r.errors.push(`line ${i + 1}: list items must be "- [title](url): optional notes"`); continue; }
      links++;
      if (!isAbsUrl(m[2]) && !m[2].startsWith('/')) r.errors.push(`line ${i + 1}: link "${m[2]}" must be an absolute URL or start with /`);
      if (!m[3]) r.warnings.push(`line ${i + 1}: add ": what the reader gets there" after the link`);
    }
  }
  if (!sections) r.errors.push('add at least one "## Section" with links');
  if (!links) r.errors.push('no links found; list the pages an answer engine should read');
  r.info = `${sections} section(s), ${links} link(s)`;
  return r;
}

/* ---------------- AGENTS.md ---------------- */
export function checkAgentsMd(text) {
  const r = result('AGENTS.md');
  if (text === null) { r.errors.push('AGENTS.md not found at the repo root'); return r; }
  // Ignore blocks installed by tools (e.g. UntilShip's own section); they say nothing about this repo.
  text = text.replace(/<!--\s*untilship:start\s*-->[\s\S]*?<!--\s*untilship:end\s*-->/g, '');
  const chars = text.replace(/\s/g, '').length;
  const h2 = (text.match(/^##\s+\S/gm) || []).length;
  const hasCode = /```[\s\S]*?```/.test(text) || /`[^`\n]{3,}`/.test(text);
  if (chars < 200) r.errors.push(`too short (${chars} non-space chars); describe setup, build, test and conventions`);
  if (h2 < 2) r.errors.push(`needs at least 2 "## " sections (found ${h2})`);
  if (!hasCode) r.errors.push('include the actual commands (in `code` or a fenced block)');
  r.info = `${chars} chars, ${h2} sections`;
  return r;
}

/* ---------------- JSON-LD ---------------- */
function htmlFiles(dir, limit = 3000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) stack.push(p); } else if (/\.html?$/i.test(e.name)) out.push(p);
    }
  }
  return out.sort();
}

export function checkJsonLd(siteDir) {
  const r = result('JSON-LD');
  const files = htmlFiles(siteDir);
  if (!files.length) { r.errors.push(`no HTML files in ${siteDir}`); return r; }
  const home = join(siteDir, 'index.html');
  if (!existsSync(home)) r.errors.push(`no index.html (home page) in ${siteDir}`);
  let blocks = 0;
  let pagesWith = 0;
  let homeTypes = [];
  const orgish = ['Organization', 'Corporation', 'LocalBusiness', 'WebSite', 'OnlineStore', 'OnlineBusiness', 'NGO', 'EducationalOrganization', 'NewsMediaOrganization'];
  for (const f of files) {
    const rel = relative(siteDir, f).split(sep).join('/');
    const bs = extractJsonLdBlocks(readFileSync(f, 'utf8'));
    if (bs.length) pagesWith++;
    bs.forEach((b, i) => {
      blocks++;
      const v = validateText(b);
      v.errors.forEach((e) => r.errors.push(`${rel}#${i + 1} ${e}`));
      v.warnings.forEach((w) => r.warnings.push(`${rel}#${i + 1} ${w}`));
      if (f === home) homeTypes.push(...v.types);
    });
  }
  if (existsSync(home) && !homeTypes.some((t) => orgish.includes(t))) r.errors.push('index.html needs an Organization or WebSite JSON-LD block');
  if (pagesWith < files.length) r.warnings.push(`${files.length - pagesWith} of ${files.length} page(s) have no JSON-LD`);
  r.info = `${blocks} block(s) on ${pagesWith}/${files.length} page(s)`;
  return r;
}

/* ---------------- robots.txt (RFC 9309) ---------------- */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (cur) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else if (key === 'sitemap') {
      sitemaps.push(val);
    } else lastWasAgent = false;
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;
  let re = '^';
  for (const ch of rulePath) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re).test(path);
}

/** Is `path` allowed for crawler `agent`? Returns { allowed, matchedGroup }. */
export function robotsAllows(parsed, agent, path = '/') {
  const token = agent.toLowerCase();
  let groups = parsed.groups.filter((g) => g.agents.includes(token));
  let matchedGroup = agent;
  if (!groups.length) { groups = parsed.groups.filter((g) => g.agents.includes('*')); matchedGroup = '*'; }
  if (!groups.length) return { allowed: true, matchedGroup: 'none' };
  const rules = groups.flatMap((g) => g.rules);
  let best = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const len = rule.path.replace(/[*$]/g, '').length;
    if (!best || len > best.len || (len === best.len && rule.allow && !best.allow)) best = { ...rule, len };
  }
  return { allowed: best ? best.allow : true, matchedGroup };
}

export function checkRobots(text, crawlers) {
  const r = result('robots.txt');
  if (text === null) { r.errors.push('robots.txt not found in site_dir'); return { r, parsed: { groups: [], sitemaps: [] } }; }
  const parsed = parseRobots(text);
  const blocked = [];
  for (const c of crawlers) {
    const { allowed, matchedGroup } = robotsAllows(parsed, c, '/');
    if (!allowed) blocked.push(`${c} (via "User-agent: ${matchedGroup}")`);
  }
  if (blocked.length) r.errors.push(`disallows "/" for: ${blocked.join(', ')}`);
  if (!parsed.sitemaps.length) r.warnings.push('add a "Sitemap: https://.../sitemap.xml" line');
  r.info = `${crawlers.length - blocked.length}/${crawlers.length} AI crawler(s) allowed`;
  return { r, parsed };
}

/* ---------------- sitemap ---------------- */
export function checkSitemapXml(xml, baseUrl) {
  const errors = [];
  const warnings = [];
  if (!/<(urlset|sitemapindex)\b/i.test(xml)) errors.push('not a sitemap: no <urlset> or <sitemapindex> element');
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
  if (!locs.length) errors.push('no <loc> entries');
  const badLocs = locs.filter((l) => !isAbsUrl(l));
  if (badLocs.length) errors.push(`<loc> must be absolute URLs: ${badLocs.slice(0, 3).join(', ')}`);
  if (baseUrl && isAbsUrl(baseUrl)) {
    const host = new URL(baseUrl).host;
    const other = locs.filter((l) => isAbsUrl(l) && new URL(l).host !== host);
    if (other.length) warnings.push(`${other.length} <loc> URL(s) are not on ${host}`);
  }
  return { errors, warnings, count: locs.length };
}

async function fetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'untilship-aeo-check/0.1' } });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: '', error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}

export async function checkSitemap(siteDir, baseUrl, robotsSitemaps) {
  const r = result('sitemap');
  if (baseUrl) {
    const urls = robotsSitemaps.length ? robotsSitemaps : [new URL('/sitemap.xml', baseUrl).href];
    const url = urls[0];
    const res = await fetchText(url);
    if (res.status !== 200) { r.errors.push(`GET ${url} -> ${res.status || res.error}`); return r; }
    const x = checkSitemapXml(res.text, baseUrl);
    r.errors.push(...x.errors); r.warnings.push(...x.warnings);
    r.info = `reachable at ${url}, ${x.count} URL(s)`;
    return r;
  }
  let file = join(siteDir, 'sitemap.xml');
  if (robotsSitemaps.length && isAbsUrl(robotsSitemaps[0])) {
    const p = new URL(robotsSitemaps[0]).pathname.replace(/^\/+/, '');
    if (p) file = join(siteDir, ...p.split('/'));
  }
  if (!existsSync(file)) { r.errors.push(`${relative(process.cwd(), file) || file} not found`); return r; }
  const x = checkSitemapXml(readFileSync(file, 'utf8'), null);
  r.errors.push(...x.errors); r.warnings.push(...x.warnings);
  r.warnings.push('checked as a local file only; set base_url to verify it is reachable over HTTP');
  r.info = `local ${relative(process.cwd(), file)}, ${x.count} URL(s)`;
  return r;
}

/* ---------------- run all ---------------- */
export async function runAeoChecks({ root = process.cwd(), siteDir = 'public', baseUrl = '', crawlers = DEFAULT_CRAWLERS } = {}) {
  const site = resolve(root, siteDir);
  const read = (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null);
  const results = [];
  if (!existsSync(site)) {
    const r = result('site_dir'); r.errors.push(`site_dir "${siteDir}" does not exist`); return [r];
  }
  const llms = read(join(site, 'llms.txt'));
  let lr;
  if (llms === null) { lr = result('llms.txt'); lr.errors.push(`${siteDir}/llms.txt not found`); } else lr = checkLlmsTxt(llms);
  if (baseUrl) {
    const res = await fetchText(new URL('/llms.txt', baseUrl).href);
    if (res.status !== 200) lr.errors.push(`GET ${new URL('/llms.txt', baseUrl).href} -> ${res.status || res.error}`);
  }
  results.push(lr);
  results.push(checkAgentsMd(read(join(root, 'AGENTS.md'))));
  results.push(checkJsonLd(site));
  const { r: rr, parsed } = checkRobots(read(join(site, 'robots.txt')), crawlers);
  results.push(rr);
  results.push(await checkSitemap(site, baseUrl, parsed.sitemaps));
  return results;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : ''; }
  return a;
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const crawlers = a.crawlers ? a.crawlers.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CRAWLERS;
  const baseUrl = (a['base-url'] || '').trim();
  if (baseUrl && !isAbsUrl(baseUrl)) { console.log(`base_url must be an absolute http(s) URL, got "${baseUrl}"`); process.exit(1); }
  const results = await runAeoChecks({ root: resolve(a.root || '.'), siteDir: a['site-dir'] || 'public', baseUrl, crawlers });
  for (const r of results) {
    console.log(`[${r.errors.length ? 'FAIL' : 'PASS'}] ${r.name}${r.info ? ': ' + r.info : ''}`);
    r.errors.slice(0, 25).forEach((e) => console.log('   ERROR ' + e));
    if (r.errors.length > 25) console.log(`   ... ${r.errors.length - 25} more error(s)`);
    r.warnings.slice(0, 10).forEach((w) => console.log('   warn  ' + w));
  }
  const passed = results.filter((r) => !r.errors.length).length;
  console.log(`AEO: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
