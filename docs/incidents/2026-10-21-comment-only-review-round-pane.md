# 2026-10-21: a review round spent only on a new code comment (pane)

- Rule: C-comments.
- Event: lens-review root `rv-20261021T121359Z-8abc79` (a harness-pane change) returned NEEDS_FIXES with one blocking finding: a new comment on a style constant carried a history clause ("so the pane looks as it did with `bold`"), outside K5.14's allowed kinds.
- Cost: one fix commit and one delta review for a change whose code was otherwise accepted.
- Why the rule: the comment was written at edit time and only caught at review time; a write-time check stops it before the round starts.
