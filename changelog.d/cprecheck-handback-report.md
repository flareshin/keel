### Fixed

- `measure/metrics/C-precheck`: `mutation_tests_findings` now reads a review report handed back through `SubagentHandback`, and counts blocking findings labelled `ADJUSTED` or `no repro`. Before, it read only assistant text and was null for every review from 2026-11-10 on (39 of 39 NEEDS_FIXES first reviews), and it skipped labelled findings in older ones. `hooks/lib/hookkit/transcript.ts` gains `finalReport`, tested on the harness-contract fixtures.
