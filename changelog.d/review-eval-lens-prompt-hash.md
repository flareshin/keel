### Changed

- `measure/evals/review-eval` reports `lens_prompts` in its JSON output and its `keel-review-eval.jsonl` line. For each run `<case>-<n>`, it holds a sha256 of the `lenses` and `guardrails` the driver session wrote into the workflow args. The case repo path, its parent and commit ids are normalized out, so only the wording counts. The driver rewrites these prompts from `caller_skill` on every run, and the reviewer fingerprint did not cover them. A recall change between two runs could therefore come from different lens wording, with nothing in the record showing it.
