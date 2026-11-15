### Fixed

- Two ship-gate gc runs at once no longer record a spurious `error` fire. When both tried to trim the node compile cache, the second run's rename of an already-retired version folder failed with ENOENT; it now skips that folder, since the other run handles it, and counts only the folders it retired itself in `compile cache removed <files> files <bytes> bytes`.
