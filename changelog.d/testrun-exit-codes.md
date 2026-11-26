### Changed

- `keel test` exits 8, not 5, when the command exits 0 but its output stays open and silent past the idle limit, so the code no longer collides with pytest's and unittest's exit 5; when the command itself failed, `keel test` now keeps the command's exit instead of replacing it.

### Fixed

- A green run that changed the working tree exited 0 with no evidence and no reason. It now exits 7 and prints `the working tree changed while the command ran; no evidence written`.
- A run whose output reported failures under a green exit (exit 6) was logged as a pass, so a later pass of the same command on the same tree carried no `[K3]` flaky warning and no `passed_after_failure`. Each `keel-tests.jsonl` row now carries `keel_exit`, the code `keel test` returned, beside `exit`, the command's own exit, and the flaky check counts a recognized-failure row as a failure.
