### Fixed
- `bin/changelog --write` rerun for a version it already wrote now names the fragments still in `changelog.d/`, so a run that stopped before deleting them can be finished by hand instead of folding them into the next release.
