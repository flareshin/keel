### Fixed

- `keel evidence check` reads the push mapping (`remote.<name>.push`) of `origin`, the remote of the `git push origin HEAD` it reports on, not the branch's push remote. Where `branch.<name>.pushRemote` names another remote, the check and ship-gate now give the same verdict.
