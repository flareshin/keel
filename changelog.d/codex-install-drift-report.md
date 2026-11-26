### Changed

- `codex/bin/link` lists every dangling link in `~/.agents/skills` under a new `notices` key of its dry-run, `--check` and `--write` output (the exit code is unchanged), and lists `forget <path>` when a skill it does not own leaves the sources, where it used to drop that registry record without a word. The README now names `--check` as the drift check to run after a merge.
