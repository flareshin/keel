### Changed

- `measure/evals/review-eval` writes its `keel-review-eval.jsonl` summary line for every full run, faulted ones included, and the line carries `faults` (how many runs faulted and were left out of `numbers`). A faulted full run used to leave no line, so a run that hit a driver fault left no record beside the clean ones; compare only lines with `faults: 0`.
