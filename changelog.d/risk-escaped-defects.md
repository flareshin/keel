### Added
- `measure/metrics/risk` attributes escaped defects from the overlay `defects-*` runners to the risk class of the earliest ship whose head contains the offending commit, so the pilot's escaped-defect input is a count per class instead of `no source`; items that reach no ship are listed as `untraced_defects` with a reason, and a failing runner is shown in `defect_sources` rather than counted as 0.

### Changed
- `measure/run` and the `run:` metric path carry a runner's extra top-level output keys into the result, so `run:risk` shows `defect_sources` and `untraced_defects`; a runner that prints only `count` and `items` yields the same result as before.
