### Added

- `docs/DESIGN.md` section 9 records that Code Mode script calls reach keel's PreToolUse gates under their usual tool names, and that the `/ship` and `/steward` watch runs its git and gh commands outside them.
- Ledger rows `risk` and `F-hookskip` record the owner's exception: `/steward` may watch a PR opened by `/ship1` in a `push_approval=false` repo; built-in `/ship` is not used on company repos.
