# Reusing approved review series

A single valid review chain remains the first choice. If no single chain covers the outgoing range, the gate searches for independently approved chains that together span the outgoing merge base to its final commit.

For A → B → C, the first chain must start at A and end at the exact tree of B. The second must start at commit B and end at the exact tree of C. Each interval must have complete blob, mode and deletion coverage, a passing supported review, valid provenance and an approval bound to its current head. Boundary commits must be ancestors on the outgoing history. Missing or expired evidence cannot supply an interval. Overlapping files are allowed only through these consecutive snapshots.

Chains reviewed in parallel from one base and then stacked by a conflict-free rebase form the second kind of interval: a run of first-parent commits, from the run's first parent to its last commit, whose blobs, modes and deletions the chain reviewed. The chain's root `review_base` must equal or be an ancestor of the outgoing merge base. Two stacked chains that changed one path fail, because the stacked blob is in neither review: no reviewer saw the two changes together. The deny names the path, the chains that reviewed it and the last commit that changed it. Review that commit from its parent (`diffs: [{repo, base: <parent>, head: <commit>}]`) and approve it; that review is a consecutive interval, so the series then passes.

The complete outgoing range still needs current test evidence and its usual test-path obligation. A waiver from one interval is not inherited by the whole range. Existing submodule checks remain in force. Additional integration edits require their own review and approval; arbitrary unions of reviewed files do not qualify.

This is evidence reuse, not a new review or approval record. `Decision.root_run_ids` identifies all selected roots in chronological order. `root_run_id` continues to identify a single-chain decision and is absent for a composed decision. Existing gate logs have no singular root for composed decisions.

## Reading guide

Entry point: `lib/evidence/verify.py:judge`.
Flow: try a single chain → search approved predecessors by exact tree or by a stacked run of commits → validate every interval → verify final tests and test-path obligation.
Changed: a range covered by consecutive approved chains, or by approved chains stacked by rebase, can pass without another whole-range review.
Unchanged: single-chain decisions, review provenance, approval binding, evidence expiry, test coverage and submodule enforcement.
Decisions: search backwards over ancestor commits and backtrack through alternative chains; visit each boundary once because valid predecessors depend only on that boundary. Require approval for every reused interval, including ordinary pushes. Return no aggregate waiver. Keep the singular root unset when several roots establish coverage. Stay inside the hook timeout: judge each chain's verdict, kind, provenance, approval and base scope once; read each first-parent commit's diff once and build every stacked run's net diff in memory; group consecutive candidates by review base; skip a chain whose reviewed paths miss a changed path before any per-chain git call.
Rejected: combining per-file approvals without commit or exact tree boundaries, matching stacked commits by patch identity (it proves the same change, not that the combined file was reviewed; `git patch-id` also ignores whitespace), manufacturing an aggregate review, or treating an approval acknowledgement as approval.
Read first: `_approved_predecessors` (`_consecutive_predecessors`, `_stacked_predecessors`), `_chain_reasons`, and the final test checks in `judge`.
