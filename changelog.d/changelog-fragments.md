### Changed
- Changelog entries now go in `changelog.d/<change-name>.md`, one file per branch, instead of the `[Unreleased]` section of `CHANGELOG.md`. Since October that section was the most frequent merge conflict (16 merges, against 4 for the next file), and each resolution needed its own delta review before the approval. The Unreleased entries written before this change moved unchanged into `changelog.d/00-unreleased-before-fragments.md`. A test fails when the Unreleased section holds more than its pointer.

### Added
- `bin/changelog <version> <date>` prints the release section folded from the fragments; `--write` writes it into `CHANGELOG.md` and deletes the fragments.
