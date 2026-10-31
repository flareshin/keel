# 2026-10-21: five review rounds on test gaps a census would have listed

- Rule: C-precheck.
- Event: a TS frontend change of three or more source files went through five consecutive NEEDS_FIXES lens-review runs (`rv-20261021T172429Z-96c1b7`, `-5595a7`, `-2eb780`, `-fe8b11`, `-9cc1f3`) before PASS at `rv-20261021T184924Z-1f234b`; the rounds that recorded it had 2, 2, 2 and 4 mutation-shaped tests findings (a branch or boundary no test pinned).
- Cost: four extra review rounds; NEEDS_FIXES runs then took a median 16.4 minutes against 3.4 for PASS.
- Why the rule: each gap was mechanically listable before review; `keel precheck run` lists them for the author first.
