#!/usr/bin/env node
// Acceptance checklist runner for the idea-to-mvp loop. Zero dependencies.
//
// Format (markdown list; each item has a `check:` command on the next indented line,
// or inline after the text):
//
//   - [ ] Users can add an item
//     check: node test/acceptance/add.mjs
//   - [ ] Health endpoint answers  check: `node scripts/health.mjs`
//
// Exit 0 only if there is at least one item and every item's check exits 0.
// Prints "ACCEPTANCE: <passed>/<total> passed" for the loop's metric.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseChecklist(text) {
  const items = [];
  const lines = String(text).split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (!m) continue;
    let title = m[3].trim();
    let check = null;
    const inline = title.match(/^(.*?)\s+check:\s*(.+)$/);
    if (inline) { title = inline[1].trim(); check = inline[2].trim(); }
    if (!check) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim()) continue;
        const cm = next.match(/^\s+check:\s*(.+)$/);
        if (cm) check = cm[1].trim();
        break;
      }
    }
    if (check) check = check.replace(/^`+|`+$/g, '').trim();
    items.push({ line: i + 1, title, check: check || null });
  }
  return items;
}

function tailLines(s, n) {
  const ls = String(s || '').trimEnd().split(/\r?\n/);
  return ls.slice(-n).map((l) => '      ' + l).join('\n');
}

export function runChecklist(file, { cwd = process.cwd(), timeoutMs = 120000 } = {}) {
  if (!existsSync(file)) return { ok: false, error: `checklist not found: ${file}`, results: [] };
  const items = parseChecklist(readFileSync(file, 'utf8'));
  const results = items.map((it) => {
    if (!it.check) return { ...it, ok: false, exit: null, note: 'no check command: every item needs one' };
    const r = spawnSync(it.check, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    const exit = timedOut ? 124 : (r.status === null ? 1 : r.status);
    return { ...it, ok: exit === 0, exit, output: (r.stdout || '') + (r.stderr || ''), note: timedOut ? `timed out after ${timeoutMs / 1000}s` : '' };
  });
  return { ok: items.length > 0 && results.every((r) => r.ok), results, error: items.length ? null : 'checklist has no items' };
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const file = process.argv[2] || 'ACCEPTANCE.md';
  const timeoutMs = Number(process.env.CHECKLIST_TIMEOUT_S || 120) * 1000;
  const res = runChecklist(file, { timeoutMs });
  if (res.error) console.log(`checklist: ${res.error}`);
  res.results.forEach((r, idx) => {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${idx + 1}. ${r.title}${r.exit !== null && !r.ok ? ` (exit ${r.exit})` : ''}${r.note ? ` [${r.note}]` : ''}`);
    if (!r.ok && r.check) { console.log(`      $ ${r.check}`); if (r.output) console.log(tailLines(r.output, 8)); }
  });
  const passed = res.results.filter((r) => r.ok).length;
  console.log(`ACCEPTANCE: ${passed}/${res.results.length} passed`);
  process.exit(res.ok ? 0 : 1);
}
