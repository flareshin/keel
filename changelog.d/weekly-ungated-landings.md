### Added

- `measure/weekly` reports `ungated_landings` for the keel and overlay checkouts. It reads every update the checkout's reflog recorded for `origin/<integration_base>` in the metric window and sorts each landed non-merge commit by the ship-gate fires whose head reaches it from the previous tip:
  - `covered`: a pass.
  - `denied_only`: a deny.
  - `warned_only`: only the early warning that PR creation records.
  - `after_pass`: added after a pass head.
  - `no_fire`: no fire at all.

  Each bucket other than `covered` lists up to five example SHAs. A repo that is not gated, or has no reflog for that ref, reports `{ error }`, and so does an unreadable fires log or `gated-repos.tsv`.

  Known limits:
  - When one reflog update lumps several landings (a fetch after merges made elsewhere), a pass head there covers back to the previous recorded tip.
  - Fires from synthetic sessions are ignored, as in the other metrics.
