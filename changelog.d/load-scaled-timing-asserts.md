### Fixed

- Wall-clock asserts in `stacked_chains`, `testrun_chaos`, `cli`, `measure/subprocess`, `measure/eval_grade` and `precheck/readtrace` tests scale their budget by the machine's load factor (`tests/load.ts`, reusing `currentLoadFactor` from `lib/precheck/baseline.ts`), capped below the sleep a bound has to stay under, so they no longer fail on a busy machine.
- The `keelTest_countsTheSummary_whenTheCommandExitsSoonAfterALargeBurst` child exits from its write callback instead of 200 ms after an asynchronous pipe write, so a busy machine no longer drops the end of its output.
