### Fixed

- `measure/run`'s `evals:<id>` metric counts the newest in-window `keel-evals.jsonl` line of that eval id, 1 when it passes and 0 when it fails; before, every passing line counted, so an older pass kept a rule green after a newer run failed.
- `measure/evals/eval` writes the run's config fingerprint (`link_mode`, `claude_md_sha256`, `principles_md_sha256`, `skill_md_sha256`, read from the raw dir's `config.json`) on every `keel-evals.jsonl` line, including `--regrade` lines, so a line names the config it measured.
