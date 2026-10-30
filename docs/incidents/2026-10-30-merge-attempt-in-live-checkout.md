# 2026-10-30: an agent ran a merge in the live checkout

- Rule: C-isolation.
- Event: after the owner said to merge an approved branch, the agent ran `git merge` with the live keel checkout as its target; git-guard denied it ("git merge is inside the live checkout"). The owner then ran the fast-forward. In 2026-10-16..30, 22 such live `git merge` calls were denied.
- Cost if unblocked: the live checkout drives every session's hooks; a merge there outside the guarded fast-forward path skips its clean-state, provenance and exact-approval checks.
- Why the rule: only the guarded fast-forward path may move a live checkout.
