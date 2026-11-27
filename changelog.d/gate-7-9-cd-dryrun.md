### Fixed

- The command walker follows `cd -` to the directory the call left, but only when every command since that move was itself a modeled move: a `cd` with no operand, one non-option operand or `-`, a `pushd` with one non-option operand, or a `popd` with no arguments, each written bare (no wrapper such as `env` or `nohup`, no prefix assignment, not in a pipeline). After any other command, or before the call has moved, `cd -` is left unresolved: ship-gate fails closed and git-guard judges a write where the call starts. Before, `cd -` stayed in place and the wrong clone was judged.
- ship-gate passes a `git push --dry-run` (or `-n`) run outside any clone it can resolve, instead of failing closed with an internal error. A real push there still fails closed with its next step.
