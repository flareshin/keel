### Fixed
- smoke `wired-fires` no longer fails when another live session writes the real `keel-fires.jsonl` while the fixtures run. It now reads the lines appended during the run and fails only on a line with no session or with a fixture payload's session, or when the log shrank or vanished, which is what a hook that ignores `KEEL_DATA_DIR` leaves.
