### Fixed

- `keel test --affected` and `keel precheck run|rerun` reported a base ref that does not exist, such as a missing `origin/HEAD`, as "has no merge base with HEAD". They now say the ref does not resolve to a commit; for the default `origin/HEAD`, the message suggests `git remote set-head origin --auto` or `--base <ref>`.
- `keel precheck <unknown>` printed the `bind` usage. It now names the unknown subcommand, and a bare `keel precheck` lists its four subcommands.
- `keel evidence` with no subcommand listed only four of its seven subcommands; it now lists all seven. Each subcommand now refuses an option that only another subcommand takes, such as `keel evidence gc --repo <path>`, where the option used to be accepted and ignored.
- The usage text now lists `keel test --affected [--with-replays] [--base <ref>]`.
- `bin/changelog.ts` read its own location from an undecoded URL path, so a checkout whose path holds a space or other escaped character looked for `CHANGELOG.md` in a directory that does not exist. It now decodes the path with `fileURLToPath`.
