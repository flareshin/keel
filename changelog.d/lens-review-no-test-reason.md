### Fixed

- lens-review writes `no_test_reason` into a repo's KEEL-EVIDENCE when the tests-lens auditor gives a non-blank reason for that repo, so a docs-only change can pass ship-gate K3 without a placeholder test. adversarial-audit returns these as `noTestReasons`.
