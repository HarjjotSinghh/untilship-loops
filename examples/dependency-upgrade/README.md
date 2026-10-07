# Fixture: dependency-upgrade

Upgrade `tiny-math` from 1.x to 2.x. In 2.0 `add(a, b)` became `sum(...values)`, so the bump
breaks the build until `src/invoice.mjs` is updated. `node_modules/tiny-math` is a vendored
test double so tests run offline. `solution/` holds the upgraded package and the fixed source.

```bash
untilship-check start dependency-upgrade --set package=tiny-math --set target=^2.0.0 \
  --set build="node scripts/build.mjs" --set typecheck="node -e 0" \
  --set test="node --test test/invoice.test.mjs"
```
