### Fixed

- lens-review no longer returns NEEDS_FIXES with nothing to fix when the verifier fails on a finding that could not block the review (a medium in a fix delta, or a medium or high without a repro). Such a finding is listed non-blocking and `not verified`; an unverified finding that could block still keeps the review incomplete.
