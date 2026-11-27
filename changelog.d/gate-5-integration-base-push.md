### Changed

- ship-gate asks for an owner approval (`keel approve <root_run_id>`) on a `git push` that may land on the integration base, such as `git push origin feature:main`, `git push origin main` or a bare `git push` whose upstream is `main`, even where `push_approval` is not set: such a push is a merge. A destination it cannot read (a remote with `remote.<name>.push`, `push.default=matching`, a detached HEAD, a run-time word) counts as the integration base. Repos with `auto_merge=true` still land on PASS plus tests. A push of `main` after an approved local merge passes.
