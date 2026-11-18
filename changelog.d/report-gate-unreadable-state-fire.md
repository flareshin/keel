### Fixed

- report-gate: a SubagentStop that finds its turn-state file unreadable (cut short or not JSON) still passes as if the report had been handed back, and now logs a `K2` `warn` fire, `turn state unreadable; judged as handed back`, where it logged nothing.
