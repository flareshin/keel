### Fixed

- The command walker follows `cd -` to the directory the call left, as the shell does through `OLDPWD`; `cd`, `pushd` and `popd` set it. A `cd -` with no earlier directory change in the call is left unresolved, so ship-gate fails closed and git-guard judges a write where the call starts. Before, `cd -` stayed in place and the wrong clone was judged.
- ship-gate passes a `git push --dry-run` (or `-n`) whose clone it cannot resolve, instead of failing closed with an internal error. A real push there still fails closed with its next step.
