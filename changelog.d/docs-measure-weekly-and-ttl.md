### Fixed

- `skills/descending-findings` named `keel measure weekly`, which the keel CLI refuses as an unknown command; it now names `measure/weekly`, the entry point that prints `recurring_findings`.
- The `C-precheck` ledger row said review evidence expires 14 days after it is written; it expires after 30, as `lib/evidence/env.ts`, the README and DESIGN say.
