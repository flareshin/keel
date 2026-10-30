# 2026-10-13: an agent wrote a skill reference straight into both live checkouts

- Rule: C-isolation.
- Event: at 06:55:41Z one session (fires `C-isolation deny`, session `351b7651…`) wrote `skills/readable-code/references/react-perf.md` by absolute path into the live keel checkout and the same file into the live overlay checkout. git-guard denied both.
- Cost if unblocked: linked skills read the live checkouts, so an unreviewed file would have reached every session at once, with no commit, review or approval behind it.
- Why the rule: live checkouts move only by approved fast-forward; edits belong in a worktree.
