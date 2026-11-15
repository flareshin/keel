### Added

- The model-assign hook adds a one-line context pointer to `/deepening-prompts` and `/authoring-agents` on the first Agent dispatch of a session whose prompt is 500 characters or longer. It never denies or changes the input beyond the model and effort it already assigns, skips `keel:auditor`, `keel:reporter`, `keel:comment-reviewer` and dispatches made from inside a subagent, and logs a `C-dispatch` `warn` fire, which the fires metrics do not count.
