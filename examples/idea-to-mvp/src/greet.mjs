#!/usr/bin/env node
// Half built: names work, the default greeting and --shout do not exist yet.
const [name] = process.argv.slice(2);
console.log(`Hello, ${name}!`);
