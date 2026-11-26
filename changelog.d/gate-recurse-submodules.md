### Fixed

- ship-gate denies a push that recurses into submodules (`--recurse-submodules=on-demand` or `only`, or, when the command gives no recursion option, either a stored `push.recurseSubmodules` that recurses or a stored `submodule.recurse=true`) when the repo or any of its submodules is gated, since git would push the submodule commits without the gate judging them. A dry run still passes, and `-c submodule.*` or a `git config submodule.*` write in the same call is denied as run-time config.
