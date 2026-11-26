### Fixed

- `keel precheck run` and `rerun` no longer stop with `internal error: spawnSync …/node_modules/.bin/tsc ENOENT` (exit 70) in a worktree without its own `node_modules`: the typecheck runs `typescript/bin/tsc` resolved from the keel checkout, which also finds a parent folder's `node_modules`, the same place the precheck tests and the typescript guard resolve it.
- `tests/run-all.sh` stops with a message naming `npm ci` when `typescript` cannot be resolved, instead of skipping the census, mutant and run suites while TAP reports `# skipped 0`. `docs/testing.md` says `npm ci` is needed for the tests, not only the typecheck.
