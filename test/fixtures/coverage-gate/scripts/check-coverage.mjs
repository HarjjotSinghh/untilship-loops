// Stand-in for `c8 check-coverage`: compares the coverage summary to the threshold in .c8rc.json.
import { readFileSync } from 'node:fs';
const threshold = JSON.parse(readFileSync('.c8rc.json', 'utf8')).lines;
const pct = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')).total.lines.pct;
console.log(`lines: ${pct}% (threshold ${threshold}%)`);
if (pct < threshold) { console.error(`coverage ${pct}% is below ${threshold}%`); process.exit(1); }
