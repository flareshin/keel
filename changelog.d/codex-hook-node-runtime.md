### Changed

- The Codex hook command `codex/bin/link` writes no longer depends on the `PATH` of the shell that ran it. It names the node that ran the install, and a Homebrew Cellar node by its `<prefix>/bin/node` launcher when that launcher resolves to the same binary, so a `brew upgrade node` keeps the hook runnable. The command also sets `NODE_COMPILE_CACHE` to `$KEEL_DATA_DIR/state/keel/node-compile-cache`, as the Claude Code hooks do. Run `codex/bin/link --write` once after updating, then re-trust the changed hook in Codex `/hooks`.
