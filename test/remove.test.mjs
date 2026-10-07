// `untilship remove`: undoes `pull` exactly, keeps everything that is not UntilShip's, idempotent.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CLI_BIN, tmp, cleanup, check } from './helpers.mjs';

after(cleanup);

const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
};

/** Every file and directory under dir, with file contents (byte-exact comparison). */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) { out[rel + '/'] = null; walk(p); } else out[rel] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const FOREIGN_CLAUDE = {
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
  },
};

describe('untilship remove', () => {
  test('claude: repo is byte-for-byte back to its original state; foreign hooks survive; second run is a no-op', () => {
    const d = tmp();
    mkdirSync(join(d, '.claude'));
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify(FOREIGN_CLAUDE, null, 2) + '\n');
    writeFileSync(join(d, 'README.md'), '# app\n');
    const before = tree(d);
    cli(d, 'pull', '--agent', 'claude');
    assert.ok(existsSync(join(d, '.claude/skills/untilship-idea-to-mvp/SKILL.md')));
    const out = cli(d, 'remove', '--agent', 'claude');
    assert.match(out, /\.claude\/skills\/untilship-idea-to-mvp\//);
    assert.match(out, /\.claude\/settings\.json \(UntilShip Stop hook entry; other hooks and keys kept\)/);
    assert.match(out, /^ {2}\.untilship\/$/m);
    assert.deepEqual(tree(d), before);
    assert.match(cli(d, 'remove', '--agent', 'claude'), /Nothing to remove/);
    assert.deepEqual(tree(d), before);
  });

  test('all agents: hook files UntilShip created are deleted, AGENTS.md keeps the rest, indentation kept', () => {
    const d = tmp();
    mkdirSync(join(d, '.cursor'));
    writeFileSync(join(d, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: './audit.sh' }], afterFileEdit: [{ command: './fmt.sh' }] } }, null, 4) + '\n');
    writeFileSync(join(d, 'AGENTS.md'), '# Repo rules\n\nRun `make test`.');
    const before = tree(d);
    for (const a of ['claude', 'codex', 'cursor']) cli(d, 'pull', '--agent', a);
    assert.match(readFileSync(join(d, '.cursor', 'hooks.json'), 'utf8'), /^\{\n {4}"version"/, 'pull keeps 4-space indentation');
    const out = cli(d, 'remove');
    for (const p of ['.codex/hooks.json', '.claude/settings.json', '.agents/', '.codex/', '.claude/']) assert.ok(out.includes(`  ${p}\n`), p);
    assert.match(out, /AGENTS\.md \(UntilShip section; the rest kept\)/);
    assert.deepEqual(tree(d), before);
    assert.match(cli(d, 'remove'), /Nothing to remove/);
  });

  test('AGENTS.md that UntilShip created is deleted; one the user edited after pull keeps their edits', () => {
    const d = tmp();
    cli(d, 'pull', '--agent', 'codex');
    cli(d, 'remove');
    assert.deepEqual(tree(d), {});

    cli(d, 'pull', '--agent', 'codex');
    writeFileSync(join(d, 'AGENTS.md'), '# Added by the user\n\n' + readFileSync(join(d, 'AGENTS.md'), 'utf8') + '\nMore user notes.\n');
    const s = JSON.parse(readFileSync(join(d, '.codex', 'hooks.json'), 'utf8'));
    s.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'echo post' }] }];
    writeFileSync(join(d, '.codex', 'hooks.json'), JSON.stringify(s, null, 2) + '\n');
    cli(d, 'remove');
    assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8'), '# Added by the user\n\n\nMore user notes.\n');
    assert.deepEqual(JSON.parse(readFileSync(join(d, '.codex', 'hooks.json'), 'utf8')), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }] } });
  });

  test('--agent removes one agent only; shared .untilship/ and AGENTS.md stay while another agent uses them', () => {
    const d = tmp();
    cli(d, 'pull', '--agent', 'claude');
    cli(d, 'pull', '--agent', 'codex');
    const out = cli(d, 'remove', '--agent', 'codex');
    assert.match(out, /kept \.untilship\/ \(still used by: claude\)/);
    assert.ok(!existsSync(join(d, 'AGENTS.md')), 'block was the whole file and no codex/cursor install remains');
    assert.ok(!existsSync(join(d, '.codex')));
    assert.ok(existsSync(join(d, '.untilship/bin/untilship-check.cjs')));
    assert.ok(existsSync(join(d, '.claude/skills/untilship-aeo-setup/SKILL.md')));
    cli(d, 'remove', '--agent', 'claude');
    assert.deepEqual(tree(d), {});
  });

  test('--keep-reports keeps .untilship/runs/ and removes everything else', () => {
    const d = tmp();
    cli(d, 'pull', 'aeo-setup', '--agent', 'claude');
    assert.equal(check(d, ['start', 'aeo-setup']).status, 0);
    assert.equal(check(d, ['abort', 'done testing']).status, 0);
    const out = cli(d, 'remove', '--keep-reports');
    assert.match(out, /\.untilship\/bin\//);
    assert.match(out, /kept \.untilship\/runs\//);
    assert.deepEqual(readdirSync(join(d, '.untilship')), ['runs']);
    assert.equal(readdirSync(join(d, '.untilship', 'runs')).length, 1);
    assert.ok(!existsSync(join(d, '.claude')));
  });

  test('installs without an install record (0.1.0) are still removed cleanly', () => {
    const d = tmp();
    mkdirSync(join(d, '.claude'));
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify(FOREIGN_CLAUDE, null, 2) + '\n');
    cli(d, 'pull', '--agent', 'claude');
    cli(d, 'pull', '--agent', 'cursor');
    rmSync(join(d, '.untilship', 'install.json'));
    cli(d, 'remove');
    assert.deepEqual(JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8')), FOREIGN_CLAUDE);
    assert.deepEqual(Object.keys(tree(d)).sort(), ['.claude/', '.claude/settings.json']);
  });

  test('invalid hook JSON is left alone with a note, the rest is still removed', () => {
    const d = tmp();
    cli(d, 'pull', '--agent', 'cursor');
    writeFileSync(join(d, '.cursor', 'hooks.json'), '{ broken');
    const out = cli(d, 'remove');
    assert.match(out, /\.cursor\/hooks\.json is not valid JSON; left untouched/);
    assert.equal(readFileSync(join(d, '.cursor', 'hooks.json'), 'utf8'), '{ broken');
    assert.ok(!existsSync(join(d, '.cursor', 'skills')));
  });
});
