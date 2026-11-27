# 2026-08-11: a cleanup's factory reuse erased a test environment and the suite stayed green

- Rule: C-improving-structure.
- Event: in a private company repo, a pre-review cleanup round swapped a test's hand-built setup for an existing factory. The factory sets an active profile, so the tests no longer ran the no-profile environment, a deployment that forgot to set its profile at all. The reviewer showed it with a mutant: a guard change requiring an active profile left all 325 tests green, while reverting the factory alone failed 2.
- Cost: a review finding and a fix in the same round, making the refusal check cover both environments; had the cleanup run after review, the regression would have shipped unreviewed.
- Why the rule: a structural change keeps what the tests pin; a reuse that drops a case the old setup exercised is a behavior change to the pin, and only a pin that runs before and after, or a mutant, shows it.
