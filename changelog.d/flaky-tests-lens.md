### Added

- The tests lens reports flaky-test patches as fake green: an added sleep, fixed delay or longer timeout, a retry wrapper or retry setting, or skipping, quarantining or deleting an intermittent test instead of removing its nondeterminism. With no root cause in the change, the finding says to stop and ask the owner.
