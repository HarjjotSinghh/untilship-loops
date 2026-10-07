// Adapters: dist/ is generated, deterministic and up to date; pull merges hook config safely.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ROOT, CLI_BIN, tmp, cli, cleanup } from './helpers.mjs';

after(cleanup);

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const pull = (dir, ...args) => spawnSync(process.execPath, [CLI_BIN, 'pull', ...args, '--dir', dir], { encoding: 'utf8' });

describe('build-adapters', () => {
  test('dist/ matches a fresh build (run `npm run build` after editing loops/)', () => {
    const out = tmp();
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-adapters.mjs'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(tree(out), tree(join(ROOT, 'dist')));
  });

  test('hook snippets use each agent\'s documented stop-hook shape', () => {
    const claude = JSON.parse(readFileSync(join(ROOT, 'dist/claude/.claude/settings.untilship.json'), 'utf8'));
    assert.match(claude.hooks.Stop[0].hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}\/\.untilship\/bin\/untilship-check\.cjs" hook --agent claude$/);
    assert.equal(claude.hooks.Stop[0].hooks[0].type, 'command');
    const codex = JSON.parse(readFileSync(join(ROOT, 'dist/codex/.codex/hooks.untilship.json'), 'utf8'));
    assert.match(codex.hooks.Stop[0].hooks[0].command, /git rev-parse --show-toplevel/);
    const cursor = JSON.parse(readFileSync(join(ROOT, 'dist/cursor/.cursor/hooks.untilship.json'), 'utf8'));
    assert.equal(cursor.version, 1);
    assert.equal(cursor.hooks.stop[0].loop_limit, null, 'UntilShip max_laps, not Cursor\'s default 5, bounds the loop');
  });

  test('skills: one per loop per agent, in each agent\'s skill directory', () => {
    for (const [agent, dir] of [['claude', '.claude/skills'], ['codex', '.agents/skills'], ['cursor', '.cursor/skills']]) {
      for (const slug of ['idea-to-mvp', 'dependency-upgrade', 'launch-post', 'aeo-setup']) {
        const s = readFileSync(join(ROOT, 'dist', agent, dir, `untilship-${slug}`, 'SKILL.md'), 'utf8');
        assert.match(s, new RegExp(`^---\\nname: untilship-${slug}\\n`));
        assert.match(s, /You cannot mark this loop done/);
        assert.doesNotMatch(s, /\{\{loop_dir\}\}/);
        assert.equal(/disable-model-invocation: true/.test(s), agent === 'claude');
      }
    }
  });
});

describe('untilship pull', () => {
  test('claude: installs engine, loop and skill; merges Stop hook without clobbering existing hooks', () => {
    const d = tmp();
    mkdirSync(join(d, '.claude'));
    const existing = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } };
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify(existing));
    const r = pull(d, 'idea-to-mvp', '--agent', 'claude');
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['.untilship/bin/untilship-check.cjs', '.untilship/loops/idea-to-mvp/loop.md', '.untilship/loops/idea-to-mvp/checklist.mjs', '.claude/skills/untilship-idea-to-mvp/SKILL.md', '.untilship/.gitignore']) {
      assert.ok(existsSync(join(d, f)), f);
    }
    assert.ok(!existsSync(join(d, '.untilship/loops/launch-post')), 'only the requested loop');
    const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.permissions, existing.permissions);
    assert.deepEqual(s.hooks.PreToolUse, existing.hooks.PreToolUse);
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo mine');
    // idempotent
    pull(d, '--agent', 'claude');
    const s2 = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.equal(s2.hooks.Stop.filter((g) => g.hooks.some((h) => h.command.includes('untilship-check'))).length, 1);
    assert.ok(existsSync(join(d, '.untilship/loops/launch-post/loop.md')), 'no args = all free loops');
  });

  test('codex: merges .codex/hooks.json and appends the AGENTS.md block once', () => {
    const d = tmp();
    writeFileSync(join(d, 'AGENTS.md'), '# My repo\n\nRun `make`.\n');
    pull(d, 'aeo-setup', '--agent', 'codex');
    pull(d, 'aeo-setup', '--agent', 'codex');
    const md = readFileSync(join(d, 'AGENTS.md'), 'utf8');
    assert.ok(md.startsWith('# My repo'));
    assert.equal(md.split('<!-- untilship:start -->').length, 2);
    assert.ok(existsSync(join(d, '.agents/skills/untilship-aeo-setup/SKILL.md')));
    const h = JSON.parse(readFileSync(join(d, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(h.hooks.Stop.length, 1);
  });

  test('cursor: stop hook entry, version 1, existing stop hooks kept', () => {
    const d = tmp();
    mkdirSync(join(d, '.cursor'));
    writeFileSync(join(d, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: './audit.sh' }] } }));
    pull(d, '--agent', 'cursor');
    const h = JSON.parse(readFileSync(join(d, '.cursor', 'hooks.json'), 'utf8'));
    assert.deepEqual(h.hooks.stop.map((x) => x.command), ['./audit.sh', 'node .untilship/bin/untilship-check.cjs hook --agent cursor']);
  });

  test('invalid existing hook JSON aborts without writing anything', () => {
    const d = tmp();
    mkdirSync(join(d, '.claude'));
    writeFileSync(join(d, '.claude', 'settings.json'), '{ broken');
    const r = pull(d, '--agent', 'claude');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not valid JSON/);
    assert.ok(!existsSync(join(d, '.untilship')));
  });

  test('mergeHook replaces an older UntilShip entry instead of duplicating it', () => {
    const snippet = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node new/untilship-check.cjs hook' }] }] } };
    const out = cli.mergeHook('claude', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node old/untilship-check.cjs hook' }, { type: 'command', command: 'echo keep' }] }] } }, snippet);
    assert.deepEqual(out.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)), ['echo keep', 'node new/untilship-check.cjs hook']);
  });
});
