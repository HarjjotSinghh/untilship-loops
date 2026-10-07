#!/usr/bin/env node
// Demo: drive bin/untilship-check by hand against the fixtures, no agent involved.
//   1. idea-to-mvp: lap 1 fails (1/3 items), the "agent's work" lands, lap 2 passes.
//   2. coverage-gate: coverage never reaches the threshold, the run ends BLOCKED at max laps.
// Prints each hook response and copies both reports to docs/sample-reports/ with --save.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const save = process.argv.includes('--save');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

function stopHook(dir, input = {}) {
  const r = sh(process.execPath, [join(dir, '.untilship/bin/untilship-check.cjs'), 'hook', '--agent', 'claude'], {
    cwd: dir, input: JSON.stringify({ session_id: 'demo', cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, ...input }),
    env: { ...process.env, UNTILSHIP_RUNNER: '' },
  });
  const j = JSON.parse(r.stdout);
  console.log(j.decision === 'block' ? `  -> BLOCK (Claude keeps working)\n${j.reason.split('\n').map((l) => '     ' + l).join('\n')}` : `  -> ALLOW STOP: ${j.systemMessage || '(no loop active)'}`);
  return j;
}
function latestReport(dir) {
  const runs = join(dir, '.untilship', 'runs');
  const id = readdirSync(runs).sort().pop();
  return { id, text: readFileSync(join(runs, id, 'report.md'), 'utf8') };
}
function fresh(src) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'untilship-demo-')));
  cpSync(src, d, { recursive: true, filter: (s) => !s.startsWith(join(src, 'solution')) });
  return d;
}

say('1. idea-to-mvp: fail, then pass');
const a = fresh(join(ROOT, 'examples', 'idea-to-mvp'));
console.log(sh(process.execPath, [join(ROOT, 'bin', 'untilship'), 'pull', 'idea-to-mvp', '--agent', 'claude', '--dir', a]).stdout.trim());
console.log(sh(process.execPath, [join(a, '.untilship/bin/untilship-check.cjs'), 'start', 'idea-to-mvp'], { cwd: a }).stdout.trim());
say('   agent ends its turn (lap 1)');
stopHook(a);
say('   agent implements the missing items, ends its turn again (lap 2)');
cpSync(join(ROOT, 'examples', 'idea-to-mvp', 'solution'), a, { recursive: true });
stopHook(a, { stop_hook_active: true });
const passReport = latestReport(a);

say('2. coverage-gate: never reaches the threshold -> BLOCKED');
const b = fresh(join(ROOT, 'test', 'fixtures', 'coverage-gate'));
sh(process.execPath, [join(ROOT, 'bin', 'untilship'), 'pull', 'idea-to-mvp', '--agent', 'claude', '--dir', b]); // installs the engine
console.log(sh(process.execPath, [join(b, '.untilship/bin/untilship-check.cjs'), 'start', 'coverage-gate'], { cwd: b }).stdout.trim());
for (let lap = 1; lap <= 3; lap++) {
  say(`   agent ends its turn (lap ${lap})`);
  if (lap === 3) {
    const { id } = latestReport(b);
    writeFileSync(join(b, '.untilship', 'runs', id, 'blockers.md'), 'Coverage is 72% and the remaining uncovered code is the CSV importer, which needs fixture bank exports we do not have. A human must supply sample exports or lower the target in a reviewed PR.\n');
  }
  stopHook(b, { stop_hook_active: lap > 1 });
  appendFileSync(join(b, 'src', 'app.mjs'), `// attempt ${lap}\n`);
}
const blockedReport = latestReport(b);

say(`Pass report (${a}/.untilship/runs/${passReport.id}/report.md):`);
console.log(passReport.text);
say(`Blocked report (${b}/.untilship/runs/${blockedReport.id}/report.md):`);
console.log(blockedReport.text);

if (save) {
  const out = join(ROOT, 'docs', 'sample-reports');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'idea-to-mvp-passed.md'), passReport.text);
  writeFileSync(join(out, 'coverage-gate-blocked.md'), blockedReport.text);
  console.log(`saved to ${out}`);
}
