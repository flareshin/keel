### Removed

- `bin/link --unlink` no longer prints the keel v1 restore command (`git -C <data dir> checkout v1-final -- <paths>`) or the warning that the `v1-final` tag is missing; it prints nothing on stderr when it finishes cleanly. `--accept-drops` stays, since `--adopt` needs it.
