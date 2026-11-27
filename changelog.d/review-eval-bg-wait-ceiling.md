### Fixed

- `measure/evals/review-eval` faulted a case whose lens-review workflow ran past 10 minutes: Claude Code's print mode stops background tasks once `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (default 10 minutes) has passed after the last turn, so the workflow record read `killed`. The driver now runs with the ceiling set to 0, whatever the caller's environment says; `--timeout-seconds` still bounds the run. Each run's driver stderr, where print mode reports the stop, is now saved as `<case>-<n>.stderr.txt` beside the stream.
