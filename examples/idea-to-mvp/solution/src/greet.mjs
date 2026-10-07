#!/usr/bin/env node
const args = process.argv.slice(2);
const shout = args.includes('--shout');
const name = args.find((a) => !a.startsWith('--')) || 'world';
const line = `Hello, ${name}!`;
console.log(shout ? line.toUpperCase() : line);
