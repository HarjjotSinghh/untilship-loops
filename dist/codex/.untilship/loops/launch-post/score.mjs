#!/usr/bin/env node
// Launch-post scorer: deterministic gates + a model-judged panel score. Zero dependencies.
//
// The model judges; this script does the arithmetic and owns the pass/fail decision.
//
//   node score.mjs --post launch/post.md --brief launch/brief.md --panel launch/panel.json \
//     --rubric rubric.md --prompt score-prompt.md --threshold 85 [--min-words 150] [--max-words 600]
//     [--require-external-judge true] [--judge "<cmd>"]
//   node score.mjs --hash launch/post.md      # prints the sha256 a self-run panel must reference
//
// Judge modes:
//   external: $UNTILSHIP_JUDGE (or --judge) is a command that reads the prompt on stdin and
//             prints text containing {"judges":[...]}. Fresh process, fresh context.
//   self:     no judge configured; reads --panel JSON written from fresh-context subagents.
//             Labelled "self-judged" because the same agent session produced it.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HYPE = [
  'excited to announce', 'thrilled to', 'proud to announce', 'game-changer', 'game changer',
  'revolutionary', 'revolutionize', 'cutting-edge', 'cutting edge', 'next-generation', 'next-gen',
  'seamless', 'seamlessly', 'unlock the power', 'leverage', 'synergy', 'world-class', 'best-in-class',
  'disrupt', 'paradigm shift', "in today's fast-paced", 'look no further', 'supercharge', 'skyrocket',
  'empower', 'unleash', 'elevate your', 'groundbreaking',
];

export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

export function parseRubric(md) {
  const criteria = [];
  for (const line of String(md).split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+([a-z][a-z0-9_]*)\s+\((\d+(?:\.\d+)?)\):\s*(.+)$/);
    if (m) criteria.push({ id: m[1], weight: Number(m[2]), text: m[3].trim() });
  }
  const total = criteria.reduce((s, c) => s + c.weight, 0);
  if (!criteria.length) throw new Error('rubric has no criteria lines like "- hook (20): ..."');
  if (Math.abs(total - 100) > 1e-9) throw new Error(`rubric weights add up to ${total}, not 100`);
  return criteria;
}

function urlsIn(text) { return (String(text).match(/https?:\/\/[^\s)<>\]"']+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')); }

export function gates(post, brief, { minWords = 150, maxWords = 600 } = {}) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  add('brief present', Boolean(brief && brief.trim()), brief && brief.trim() ? 'ok' : 'write the brief first (what, who, proof, link, channel)');
  if (post === null) { add('post present', false, 'post file not found'); return out; }
  add('post present', post.trim().length > 0, post.trim() ? 'ok' : 'post is empty');
  const lines = post.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim()) || '';
  const h1s = lines.filter((l) => /^#\s+\S/.test(l));
  const title = firstLine.replace(/^#\s+/, '').trim();
  add('title', /^#\s+\S/.test(firstLine) && h1s.length === 1 && title.length <= 90,
    !/^#\s+\S/.test(firstLine) ? 'first line must be "# Title"' : h1s.length !== 1 ? `exactly one "# " title allowed, found ${h1s.length}` : title.length > 90 ? `title is ${title.length} chars (max 90)` : 'ok');
  const words = (post.replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  add('length', words >= minWords && words <= maxWords, `${words} words (allowed ${minWords}-${maxWords})`);
  const briefUrls = urlsIn(brief || '');
  const postUrls = urlsIn(post);
  const linkOk = briefUrls.length ? briefUrls.some((u) => postUrls.includes(u)) : postUrls.length > 0;
  add('link', linkOk, linkOk ? 'ok' : briefUrls.length ? `include the brief's link (${briefUrls[0]})` : 'include the link readers should open');
  const ph = post.match(/\b(TODO|TBD|FIXME)\b|lorem ipsum|\[(link|url|here)\]|\bXXX\b|\{\{[^}]*\}\}/i);
  add('no placeholders', !ph, ph ? `found placeholder "${ph[0]}"` : 'ok');
  const lower = post.toLowerCase();
  const hype = HYPE.filter((h) => new RegExp(`(^|[^a-z])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(lower));
  add('no hype words', hype.length === 0, hype.length ? `remove: ${hype.join(', ')}` : 'ok');
  const bangs = (post.match(/!/g) || []).length - (post.match(/!\[/g) || []).length;
  add('exclamation marks', bangs <= 2, `${bangs} (max 2)`);
  return out;
}

export function extractJson(text) {
  const s = String(text);
  const starts = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '{') starts.push(i);
  for (const st of starts) {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = st; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(s.slice(st, i + 1)); if (o && Array.isArray(o.judges)) return o; } catch { /* keep scanning */ } break; } }
    }
  }
  return null;
}

export function normaliseJudges(raw, criteria) {
  const flat = [];
  for (const j of raw || []) {
    if (j && Array.isArray(j.judges)) flat.push(...j.judges); else flat.push(j);
  }
  const errors = [];
  const judges = flat.filter(Boolean).map((j, idx) => {
    const name = j.name || `judge_${idx + 1}`;
    const scores = {};
    for (const c of criteria) {
      const v = Number(j.scores && j.scores[c.id]);
      if (!Number.isFinite(v) || v < 0 || v > 10) errors.push(`${name}: missing or invalid score for "${c.id}"`);
      scores[c.id] = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0;
    }
    const total = criteria.reduce((s, c) => s + (c.weight * scores[c.id]) / 10, 0);
    return { name, scores, total, fix: j.fix || '' };
  });
  if (!judges.length) errors.push('no judges in panel output');
  return { judges, errors };
}

export function buildPrompt(promptMd, rubricMd, brief, post) {
  return `${promptMd.trim()}\n\n=== RUBRIC ===\n${rubricMd.trim()}\n\n=== BRIEF ===\n${(brief || '').trim()}\n\n=== POST ===\n${post.trim()}\n`;
}

function readOr(file, fallback = null) { return file && existsSync(file) ? readFileSync(file, 'utf8') : fallback; }

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[k] = 'true'; else { a[k] = v; i++; } }
  }
  return a;
}

export function score(opts) {
  const report = [];
  const log = (s = '') => report.push(s);
  const post = readOr(opts.post);
  const brief = readOr(opts.brief, '');
  const criteria = parseRubric(readFileSync(opts.rubric, 'utf8'));
  const g = gates(post, brief, { minWords: Number(opts.minWords || 150), maxWords: Number(opts.maxWords || 600) });
  const gatesOk = g.every((x) => x.ok);
  log(`GATES: ${g.filter((x) => x.ok).length}/${g.length} passed`);
  for (const x of g) log(`  ${x.ok ? 'PASS' : 'FAIL'} ${x.name}: ${x.detail}`);
  if (!gatesOk) { log('PANEL: skipped until every gate passes'); return { ok: false, gatesOk, report: report.join('\n') }; }

  let mode; let raw; let judgeErr = null;
  const judgeCmd = opts.judge || process.env.UNTILSHIP_JUDGE || '';
  if (judgeCmd) {
    mode = `external (${judgeCmd})`;
    const prompt = buildPrompt(readFileSync(opts.prompt, 'utf8'), readFileSync(opts.rubric, 'utf8'), brief, post);
    const r = spawnSync(judgeCmd, { shell: true, input: prompt, encoding: 'utf8', timeout: Number(process.env.UNTILSHIP_JUDGE_TIMEOUT_S || 300) * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, UNTILSHIP_RUNNER: '1' } });
    if (r.status !== 0) judgeErr = `judge command exited ${r.status}${r.error ? ': ' + r.error.message : ''}: ${(r.stderr || '').slice(-500)}`;
    else { const o = extractJson(r.stdout); if (!o) judgeErr = 'judge output had no {"judges": [...]} JSON'; else raw = o.judges; }
  } else {
    mode = 'self-judged (fresh-context subagents in the same session; not independent)';
    const panelText = readOr(opts.panel);
    if (!panelText) judgeErr = `no judge configured (set UNTILSHIP_JUDGE) and no ${opts.panel}. Run the panel as described in the loop, then write ${opts.panel}`;
    else {
      let panel;
      try { panel = JSON.parse(panelText); } catch (e) { judgeErr = `${opts.panel} is not valid JSON: ${e.message}`; }
      if (panel) {
        if (panel.post_sha256 !== sha256(post)) judgeErr = `${opts.panel} scores a different version of the post (post_sha256 mismatch); re-run the panel on the current post`;
        else raw = panel.judges;
      }
    }
  }
  log(`JUDGE: ${mode}`);
  if (judgeErr) { log(`PANEL: ${judgeErr}`); return { ok: false, gatesOk, report: report.join('\n') }; }
  const { judges, errors } = normaliseJudges(raw, criteria);
  if (errors.length) { log('PANEL: invalid scores:'); errors.forEach((e) => log('  - ' + e)); return { ok: false, gatesOk, report: report.join('\n') }; }
  const mean = judges.reduce((s, j) => s + j.total, 0) / judges.length;
  const rounded = Math.round(mean * 10) / 10;
  const threshold = Number(opts.threshold || 85);
  log(`Per criterion (mean of ${judges.length} judges, 0-10):`);
  for (const c of criteria) {
    const avg = judges.reduce((s, j) => s + j.scores[c.id], 0) / judges.length;
    log(`  ${c.id.padEnd(16)} ${avg.toFixed(1)}  (weight ${c.weight})`);
  }
  for (const j of judges) log(`  ${j.name}: ${j.total.toFixed(1)}${j.fix ? ` | fix: ${j.fix}` : ''}`);
  log(`PANEL SCORE: ${rounded} / 100 (threshold ${threshold})`);
  const external = Boolean(judgeCmd);
  const requireExternal = String(opts.requireExternalJudge) === 'true';
  if (requireExternal && !external) log('Self-judged panels cannot pass this run (require_external_judge=true).');
  const ok = rounded >= threshold && (!requireExternal || external);
  log(ok ? 'RESULT: PASS' : 'RESULT: below threshold, rewrite and re-score');
  return { ok, gatesOk, score: rounded, mode, report: report.join('\n') };
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (a.hash) { console.log(sha256(readFileSync(a.hash, 'utf8'))); process.exit(0); }
  try {
    const r = score({
      post: a.post || 'launch/post.md', brief: a.brief || 'launch/brief.md', panel: a.panel || 'launch/panel.json',
      rubric: a.rubric, prompt: a.prompt, threshold: a.threshold, minWords: a['min-words'], maxWords: a['max-words'],
      requireExternalJudge: a['require-external-judge'], judge: a.judge,
    });
    console.log(r.report);
    process.exit(r.ok ? 0 : 1);
  } catch (e) { console.log(`score.mjs: ${e.message}`); process.exit(1); }
}
