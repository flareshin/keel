### Added

- Harness contract tests: report-gate now runs against four scrubbed agent transcripts the harness really wrote (versions 2.1.309 to 2.1.325, final-text and `SubagentHandback` endings), so a renamed transcript field fails a test instead of silently turning a gate off. `tests/hooks/harness-contract-record.ts` records a new one.
