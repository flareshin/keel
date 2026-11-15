### Changed
- `keel test` now also reads the failure counts of the runner summaries it already counts (surefire `Failures`/`Errors`, unittest `FAILED (…)`, TAP `# fail N`, node spec `ℹ fail N`, `N failed`). When the command exits 0 but its output reports failing tests, as a `bash -c '… | …'` pipe that hides the runner's exit does, it writes no evidence, names the count on stderr and exits 6.
