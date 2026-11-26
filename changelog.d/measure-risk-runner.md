### Fixed

- `measure/metrics/risk` bounds a fast-forwarded ship's base by its pass line's diff stat (`files`, `lines`): the base is the nearest first-parent commit back to the repo's earlier ship whose diff to the head matches, and the ship is not computable when none does. Before, the base was the earlier ship itself and took in every commit between them, which inflated light rework to 39.6 % in the 2026-11-14 pilot result (7.1 % without that ship; the drop decision stands, see DESIGN §6.1). The rework cache file is now `{"version": 2, "ships"}`, and a file of an earlier version is recomputed, so figures cached under the old base are dropped.
- The rework cache is written after each decided ship, so a run stopped by the runner timeout keeps the ships it finished; per-checkout git facts are read once per run.
- An unreadable review or approval evidence file is skipped and counted as `unreadable_evidence` instead of failing the run.
