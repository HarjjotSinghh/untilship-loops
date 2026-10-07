<!-- untilship:start -->
## UntilShip loops

This repo uses UntilShip loops (`.untilship/loops/`). When a loop is active
(`node .untilship/bin/untilship-check.cjs status`), a stop hook re-runs the loop's check every time you finish a turn
and sends you back to work until it passes or the lap limit is hit. You cannot declare a
loop done. Do not edit `.untilship/`, the hook config, or the loop's protected files.
Use `node .untilship/bin/untilship-check.cjs peek` to run the check without using a lap.
<!-- untilship:end -->
