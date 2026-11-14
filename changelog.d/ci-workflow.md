### Added
- A GitHub Actions workflow (`.github/workflows/test.yml`) runs the typecheck and the full suite (`tests/run-all.sh`) on macOS for every pull request and every push to `main`, with `KEEL_DATA_DIR` in the runner's temp dir.
