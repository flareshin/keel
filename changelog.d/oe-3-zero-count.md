### Changed

- `keel test` now says why it exits 4 when the command exited 0 but no test count was recognized: `keel test: no test summary recognized; no evidence written`. When the command is `mvn` or `mvnw` (any path) with `-q` or `--quiet`, a second line explains that `-q` hides surefire's `Tests run:` line and to rerun without it. Exit codes and the evidence format are unchanged.
