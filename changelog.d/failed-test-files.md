### Fixed

- `keel test` writes no evidence and exits 6 when a run that exited 0 reports a failed test file (`Test Files  1 failed` from vitest, `Test Suites: 1 failed` from jest), even when every counted test passed, as when a file fails to load.
