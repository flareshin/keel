### Added

- `keel test` warns `[K3] warn: run <run_id> of this command failed on this same tree …` when a run writes tests evidence and an earlier run of the same command on the same repo tree failed with tests recognized, and records that run as `passed_after_failure` in `keel-tests.jsonl`. It is a flaky signal; the evidence is still written.
