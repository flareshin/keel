### Changed

- `codex/bin/link --write` refuses (exit 3) when the keel checkout it runs from is a linked worktree (`git rev-parse --git-dir` differs from `--git-common-dir`), so a worktree can no longer rewrite the live `~/.codex/AGENTS.md` and `hooks.json` or retarget the shared skill links to itself. The dry run and `--check` list the same problem (`--check` exits 1). `--allow-worktree` lifts it; `--unlink` never needs it, since it does not read the source. A git that times out on the check counts as the same problem, since it cannot rule out a worktree; a missing git does not.
