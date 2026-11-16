### Fixed

- `keel precheck run` puts the diff's own changed test files at the front of the baseline, so a baseline cut by its time budget no longer skips them and judges the diff's mutants only against unrelated tests.
