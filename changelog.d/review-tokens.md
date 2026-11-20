### Added

- `measure/weekly` reports `review_tokens`: the input, cache-creation, cache-read and output tokens the lens-review workflow runs of live review evidence spent, per model and per number of NEEDS_FIXES rounds of each root, read from the agent transcripts of the `wf_*` run each review's `source.agent_transcript_path` names. A streamed message counts once by its last line, an advisor iteration counts under its own model, and a root whose run cannot be read is counted as `unmeasured` instead of as cheap. Tokens only, no prices; authoring and fix work are not included.
