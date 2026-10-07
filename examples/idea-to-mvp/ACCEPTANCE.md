# Acceptance checklist: greet

Agreed before the loop started. Each item passes only when its check exits 0.

- [ ] `greet Ada` prints "Hello, Ada!"
  check: node test/acceptance/greet-name.mjs
- [ ] `greet` with no name prints "Hello, world!"
  check: node test/acceptance/greet-default.mjs
- [ ] `greet Ada --shout` prints "HELLO, ADA!"
  check: node test/acceptance/greet-shout.mjs
