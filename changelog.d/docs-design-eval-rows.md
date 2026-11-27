### Changed

- DESIGN's `evals:<id>` metric, `keel-evals.jsonl` row and `-v1baseline` condition now match the code: the metric reads the newest in-window line, eval lines carry the run's config fingerprint, and the plugin install has its own live check. improving-agents and review-policy no longer name a personal note store.
