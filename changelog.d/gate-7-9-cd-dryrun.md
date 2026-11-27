### Fixed

- The command walker follows `cd -` to the directory the last `cd`, `pushd` or `popd` of the call left. A `cd -` with no earlier directory change in the call, or after the call assigns, exports or unsets `OLDPWD` (bash and zsh disagree on what that does), is left unresolved, so ship-gate fails closed and git-guard judges a write where the call starts. Before, `cd -` stayed in place and the wrong clone was judged.
- ship-gate passes a `git push --dry-run` (or `-n`) run outside any clone it can resolve, instead of failing closed with an internal error. A real push there still fails closed with its next step.
