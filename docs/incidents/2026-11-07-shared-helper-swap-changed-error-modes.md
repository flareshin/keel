# 2026-11-07: a shared-helper swap passed every test and changed two error modes

- Rule: C-improving-structure.
- Event: a review flagged a hand-written recursive readdir in the eval runner as duplicating the shared `walkEntries`, and the author swapped the helper in (`efc6258`). Every test passed, but `walkEntries` returns `[]` on a read error and `isDir` follows symlinks, so an unreadable or symlinked subdirectory stopped being reported as a fault. A later review caught it and the swap was reverted the same day (`cd31b77`).
- Cost: a candidate, its review round and a revert, for a change that was meant to keep behavior the same.
- Why the rule: a structural change keeps observable behavior and error modes the same, and the behavior pin runs before and after; a green suite that never exercised the error edges was not that pin.
