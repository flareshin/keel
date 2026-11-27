### Fixed

- `keel precheck run` in a repo with no node:test file at keel's paths, such as a vitest or Maven/Gradle JUnit repo, ended as `stopped` with an `empty` baseline and exit 0, without saying why. It now refuses with exit 3, names the supported test paths and says that vitest, jest and JUnit are not supported, and records the refusal in `keel-precheck.jsonl` without a `tree`.
- `keel precheck required` answered `required: false` for such a repo with no reason. When three or more script sources change, it now adds the reason as `unsupported`, and lens-review reports it as `Precheck: unsupported: …`.
- `measure/metrics/C-precheck` counted any precheck record with a tree as prechecked, so a run whose baseline found no test counted. A `stopped` run with an `empty` baseline, or a refused run, no longer counts.
