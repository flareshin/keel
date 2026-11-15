### Added

- ship-gate now also runs at the end of each main-session turn (`Stop`). When the session's repo has commits its upstream does not hold and ship-gate would deny their push for a reason other than the owner's approval (no tests evidence for the content, no review covering it), it tells the agent the reasons once, as Stop hook feedback that continues the turn for one round, so a skipped step shows up when the turn ends instead of at the push. The same session, HEAD and reasons are told once; `stop_hook_active` turns pass; every error passes. Each reminder is logged as a `warn` fire.

### Changed

- `keel evidence check` takes its judgment from `lib/evidence/readiness.ts`, which the Stop reminder shares; its output and exit codes are unchanged.
