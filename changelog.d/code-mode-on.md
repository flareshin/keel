### Changed

- `settings/core.json` sets `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` to `1`, so `bin/link --write` turns on Claude Code's experimental Code Mode in the user settings. Code Mode needs Claude Code 2.1.323 or later and works only in an interactive `claude` session in a terminal. The Desktop app, the VS Code panel and cloud sessions do not run it, and keel has not checked what they do with the variable set. The first terminal run asks to turn Code Mode on and then restarts. The keel plugin alone cannot set an environment variable, so a plugin install gets Code Mode only after `bin/link --write`.

### Upgrading

- To keep Code Mode off, set `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` to `"0"` in an overlay `settings/*.json` `env` block before `bin/link --write`. The overlay value wins, and `bin/link` prints a settings-conflict warning for it.
