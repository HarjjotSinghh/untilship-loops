---
name: coverage-gate
title: Coverage gate (test fixture)
type: command
stop_when: line coverage is at or above the threshold in .c8rc.json
check: node scripts/check-coverage.mjs
metric: 'lines: (\d+(?:\.\d+)?)%'
metric_name: line_coverage
max_laps: 3
forbid:
  - '\bit\.skip\('
---

# Coverage gate

Test fixture for the engine: raise coverage until the check passes.
