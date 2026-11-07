# 2026-10-14: a small UI change went to a PR outside /ship1

- Rule: risk.
- Event: a small frontend change asked for mid-conversation went from analysis straight to a branch, a commit and an open PR in a company repo, with no ticket and without `/ship1`. The owner had to point out that the ticket comes first.
- Cost if unblocked: the branch name carries the ticket id, so a pushed branch with an open PR could not be renamed without closing the PR; the PR also skipped the ticket, approval and preflight steps `/ship1` runs.
- Why the rule: PR requests made any other way do not bypass `/ship1`, and `/ship1` runs only after the owner's `keel approve`; the row took that boundary on 2026-10-16.
