### Fixed

- `measure/evals/review-eval` recorded a null reviewer fingerprint under the plugin install, because it hashed `<config dir>/workflows/`, which the plugin install does not fill. It now hashes the reviewer files where they are served: the keel checkout under the plugin install, and the config dir under the link install. The fingerprint also covers `workflows/review-lenses.json`, `agents/auditor.md` and `agents/reporter.md`, and its keys are now these paths rather than bare file names.
