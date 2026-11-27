### Fixed

- git-guard resolves where a `--force-with-lease` push lands the way ship-gate does: `push.default=upstream`, a `remote.<name>.push` mapping and `git -c` overrides can send the lease onto `main` or the integration base, and F-force-push now denies it. A destination it cannot name (detached HEAD, `HEAD` as destination, routing decided at run time) counts as protected.
