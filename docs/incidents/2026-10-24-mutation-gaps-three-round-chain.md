# 2026-10-24: three review rounds on mutation-shaped test gaps

- Rule: C-precheck.
- Event: a TS frontend change of three or more source files took three NEEDS_FIXES runs (`rv-20261024T034103Z-8ef3f0`, `rv-20261024T044251Z-8691fa`, `rv-20261024T062902Z-8b046f`) with 4, 3 and 3 mutation-shaped tests findings.
- Cost: three review rounds, each finding new unpinned branches rather than repeats.
- Why the rule: the same census-before-review gap as 2026-10-21, in another repo.
