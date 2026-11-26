### Fixed

- `tsc --noEmit` is clean again on main: the hook environment list in `codex/lib/install.ts` and the unreadable plugin-record cases in `tests/hooks/model-assign.test.ts` are typed as string pairs, so their destructured values are `string`, not `string | undefined`. A red `tsc` refused `keel precheck` for every gated diff.
