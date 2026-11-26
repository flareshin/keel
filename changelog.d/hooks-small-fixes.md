### Fixed

- `handoff --help` (or `-h`) prints the CLI's modes and exits 0. Before, it was recorded as the resume note and overwrote the one you had written.
- The handoff CLI no longer logs a `C-handoff record` fire when it writes a note: that ledger row is retired, and the CLI modes stay for resume notes.
- A reviewer that writes its notes with the Write, Edit or NotebookEdit tool under `/tmp`, `/private/tmp`, `/var/folders` or `$TMPDIR` keeps its review evidence, as a Bash redirect there already did. A target that is empty or that climbs out of those directories with `..` still counts as an edit, and now so does a Bash write target that does this.
