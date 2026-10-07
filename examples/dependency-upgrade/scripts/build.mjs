// "Build": load every module so missing exports fail fast, then write dist/.
import { mkdirSync, writeFileSync } from 'node:fs';
const mod = await import('../src/invoice.mjs');
if (typeof mod.invoiceTotal !== 'function') throw new Error('invoiceTotal missing');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/build.txt', 'ok\n');
console.log('build ok');
