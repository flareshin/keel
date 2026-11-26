### Fixed

- `git push origin :` and `git push origin +:` (the matching refspec, which pushes every branch present on both sides) are no longer read as a deletion: ship-gate denies them on a gated repo like `--all`, and git-guard scans every local branch and reads `+:` as a force push.
