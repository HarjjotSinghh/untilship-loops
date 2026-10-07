#!/usr/bin/env node
// TEST DOUBLE for an external judge (stands in for `claude -p`, `codex exec -`, ...).
// Reads the scoring prompt on stdin and prints panel JSON. It is deliberately simple and
// deterministic so tests can exercise score.mjs end to end without calling a model.
import { readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const post = prompt.split('=== POST ===')[1] || '';
const ids = [...prompt.matchAll(/^\s*-\s+([a-z_]+)\s+\(\d+\):/gm)].map((m) => m[1]);
const strong = post.includes('0.4 seconds') && post.includes('312') && /https:\/\/tally\.example\.com\s*$/.test(post.trim());
const s = strong ? 9 : 5;
const judge = (name) => ({ name, scores: Object.fromEntries(ids.map((id) => [id, s])), fix: strong ? 'Tighten the second paragraph.' : 'Lead with the proof from the brief.' });
console.log('Here is the panel:\n' + JSON.stringify({ judges: [judge('target_reader'), judge('editor'), judge('growth_lead')] }));
