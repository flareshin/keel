### Fixed

- ship-gate's K1 denial no longer names an unrelated session's review chain as the one that "does not cover" a change. Only chains that reviewed at least one outgoing path are judged; when none covers the change, the denial names the chain that reviewed the most of its paths (newest on a tie), and when no chain reviewed any of them it says there is no review evidence and to run lens-review.
