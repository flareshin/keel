### Fixed

- report-gate sends all of a report's `KEEL-EVIDENCE` lines to `keel evidence write-review` within one 25 s deadline counted from the hook's start, under its registered 30 s timeout. Each call still gets at most 20 s; a line reached with less than a second left is skipped with a `K1 warn` fire instead of running past the timeout (a two-repo review took 32.5 s before).
- `tests/hooks/registered-timeouts.test.ts` reads every hook registration in `hooks/hooks.json` and `settings/core.json` and fails when a hook's longest subprocess wait does not end at least a second before its registered timeout, or when a registered hook has no wait on record.
