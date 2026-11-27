### Fixed

- The report-gate tests that check the SubagentStop hook returns without waiting for a late report now count the hook's sleeps through a test preload (`tests/sleep-log.ts`) instead of timing it, so a busy machine can no longer hide a hook that waited. A positive-control test pins that the log records the wait when neither the payload nor the turn state carries a report.
