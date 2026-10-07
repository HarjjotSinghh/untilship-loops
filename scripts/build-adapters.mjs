#!/usr/bin/env node
// Generates per-agent adapters from loops/*/loop.md into dist/<agent>/.
//
// Each dist/<agent>/ mirrors a project root, so its contents can be copied into a repo
// as-is (or installed with `untilship pull`, which also merges the hook config):
//
//   dist/<agent>/.untilship/bin/untilship-check.cjs   the enforcer (same for every agent)
//   dist/<agent>/.untilship/loops/<slug>/...          canonical loop + its scripts
//   dist/claude/.claude/skills/untilship-<slug>/SKILL.md
//   dist/claude/.claude/settings.untilship.json        Stop hook to merge into .claude/settings.json
//   dist/codex/.agents/skills/untilship-<slug>/SKILL.md
//   dist/codex/.codex/hooks.untilship.json             Stop hook to merge into .codex/hooks.json
//   dist/codex/AGENTS.untilship.md                     block to append to AGENTS.md
//   dist/cursor/.cursor/skills/untilship-<slug>/SKILL.md
//   dist/cursor/.cursor/hooks.untilship.json           stop hook to merge into .cursor/hooks.json
//   dist/manifest.json
//
// Output is deterministic (no timestamps) so CI can check dist/ is up to date:
//   node scripts/build-adapters.mjs --out <dir>   build somewhere else (used by tests)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const engine = require(join(ROOT, 'bin', 'untilship-check'));

export const AGENTS = ['claude', 'codex', 'cursor'];
const CHECK = 'node .untilship/bin/untilship-check.cjs';

export const HOOKS = {
  claude: {
    file: '.claude/settings.untilship.json',
    target: '.claude/settings.json',
    json: {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.untilship/bin/untilship-check.cjs" hook --agent claude', timeout: 3600 }] }],
      },
    },
  },
  codex: {
    file: '.codex/hooks.untilship.json',
    target: '.codex/hooks.json',
    json: {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.untilship/bin/untilship-check.cjs" hook --agent codex', timeout: 3600, statusMessage: 'UntilShip: checking the stop condition' }] }],
      },
    },
  },
  cursor: {
    file: '.cursor/hooks.untilship.json',
    target: '.cursor/hooks.json',
    json: {
      version: 1,
      hooks: {
        stop: [{ command: 'node .untilship/bin/untilship-check.cjs hook --agent cursor', timeout: 3600, loop_limit: null }],
      },
    },
  },
};

const SKILL_DIR = { claude: '.claude/skills', codex: '.agents/skills', cursor: '.cursor/skills' };

const HOW = {
  claude: 'a `Stop` hook in `.claude/settings.json`. When you end your turn it runs the stop condition; if that fails, Claude Code blocks the stop and hands you the failing output as your next instruction',
  codex: 'a `Stop` hook in `.codex/hooks.json`. When you end your turn it runs the stop condition; if that fails, Codex continues the turn with the failing output as a new prompt',
  cursor: 'a `stop` hook in `.cursor/hooks.json`. When the agent loop ends it runs the stop condition; if that fails, Cursor auto-submits the failing output as the next message (a follow-up), so a new turn starts',
};

export const AGENTS_BLOCK = `<!-- untilship:start -->
## UntilShip loops

This repo uses UntilShip loops (\`.untilship/loops/\`). When a loop is active
(\`${CHECK} status\`), a stop hook re-runs the loop's check every time you finish a turn
and sends you back to work until it passes or the lap limit is hit. You cannot declare a
loop done. Do not edit \`.untilship/\`, the hook config, or the loop's protected files.
Use \`${CHECK} peek\` to run the check without using a lap.
<!-- untilship:end -->
`;

function loopSlugs() {
  return readdirSync(join(ROOT, 'loops')).filter((d) => existsSync(join(ROOT, 'loops', d, 'loop.md'))).sort();
}

function listFiles(dir, base = '') {
  const out = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel)); else out.push(rel);
  }
  return out;
}

function yamlStr(s) { return JSON.stringify(String(s)); }

export function skillMarkdown(agent, slug, loop) {
  const body = loop.body.replace(/^\s*#\s+.*\n/, '').trim().replace(/`untilship-check /g, '`' + CHECK + ' ').replace(/^untilship-check /gm, CHECK + ' ');
  const desc = `UntilShip loop: ${loop.title}. ${loop.trigger || ''} Keeps working until ${loop.stopWhen || 'the check passes'}; a hook checks this, not the model.`.replace(/\s+/g, ' ').trim();
  const fm = ['---', `name: untilship-${slug}`, `description: ${yamlStr(desc)}`];
  if (agent === 'claude') fm.push('disable-model-invocation: true');
  fm.push('---');
  const shown = (c) => c.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) => {
    if (k === 'loop_dir') return `.untilship/loops/${slug}`;
    const v = loop.vars[k];
    if (v === undefined || v === null || v === '') return `<${k}>`;
    return Array.isArray(v) ? v.join(',') : String(v);
  });
  const checks = loop.checks.map((c) => '`' + shown(c) + '`').join(' then ');
  return `${fm.join('\n')}

# ${loop.title} (UntilShip loop)

## How this loop is enforced (read this first)

- \`untilship-check\` in this file means \`${CHECK}\`.
- Enforcement is ${HOW[agent]}.
- You cannot mark this loop done. Only the check can: ${checks} (from \`.untilship/loops/${slug}/loop.md\`).
- Editing \`.untilship/\`, the hook config, or the loop's protected files fails the lap.
- \`${CHECK} peek\` runs the check without using a lap. \`${CHECK} status\` shows the lap count.
- The run ends after ${loop.maxLaps} laps as \`blocked\`, with a report in \`.untilship/runs/<run-id>/report.md\`.
- If the human tells you to stop: \`${CHECK} abort "reason"\`.

${body}
`;
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function build(outDir = join(ROOT, 'dist')) {
  rmSync(outDir, { recursive: true, force: true });
  const slugs = loopSlugs();
  const manifest = { version: engine.VERSION, loops: {}, agents: {} };
  const loops = {};
  for (const slug of slugs) {
    const loop = engine.loadLoop(join(ROOT, 'loops', slug, 'loop.md'));
    if (loop.name !== slug) throw new Error(`loops/${slug}/loop.md: name "${loop.name}" must match its folder`);
    loops[slug] = loop;
    manifest.loops[slug] = { title: loop.title, tier: loop.tier, type: loop.type, stopWhen: loop.stopWhen, maxLaps: loop.maxLaps, files: listFiles(join(ROOT, 'loops', slug)) };
  }
  for (const agent of AGENTS) {
    const base = join(outDir, agent);
    const files = { common: ['.untilship/bin/untilship-check.cjs', HOOKS[agent].file], loops: {} };
    copyFileSync(join(ROOT, 'bin', 'untilship-check'), join(mkdirAndReturn(join(base, '.untilship', 'bin')), 'untilship-check.cjs'));
    chmodSync(join(base, '.untilship', 'bin', 'untilship-check.cjs'), 0o755);
    write(join(base, HOOKS[agent].file), JSON.stringify(HOOKS[agent].json, null, 2) + '\n');
    if (agent !== 'claude') { write(join(base, 'AGENTS.untilship.md'), AGENTS_BLOCK); files.common.push('AGENTS.untilship.md'); }
    for (const slug of slugs) {
      const own = [];
      for (const f of manifest.loops[slug].files) {
        const dst = join(base, '.untilship', 'loops', slug, f);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(join(ROOT, 'loops', slug, f), dst);
        if (statSync(join(ROOT, 'loops', slug, f)).mode & 0o111) chmodSync(dst, 0o755);
        own.push(`.untilship/loops/${slug}/${f}`);
      }
      const skill = `${SKILL_DIR[agent]}/untilship-${slug}/SKILL.md`;
      write(join(base, skill), skillMarkdown(agent, slug, loops[slug]));
      own.push(skill);
      files.loops[slug] = own;
    }
    manifest.agents[agent] = { hook: { file: HOOKS[agent].file, mergeInto: HOOKS[agent].target }, ...files };
  }
  write(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function mkdirAndReturn(d) { mkdirSync(d, { recursive: true }); return d; }

const isMain = (() => { try { return resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? resolve(process.argv[i + 1]) : join(ROOT, 'dist');
  const m = build(out);
  console.log(`built ${Object.keys(m.loops).length} loop(s) x ${AGENTS.length} agent(s) into ${out}`);
}
