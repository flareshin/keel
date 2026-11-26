### Added

- Each `keel-tests.jsonl` row now carries `failed_tests`, the names of the failing tests the output reports (at most 20, each cut to 200 characters; `[]` when none is recognized), and `selection`: `affected` or `affected_with_replays` for `keel test --affected`, `command` for `keel test -- <cmd>`. A plain command cannot tell a full suite from hand-picked files, so both log as `command`. Readers of older rows see neither field.
