### Fixed

- ship-gate and git-guard read `git push` options through one reader that follows git's parse-options rules, in place of exact-spelling sets:
  - A later negation undoes an earlier option, and the last spelling wins (`-n --no-dry-run` is a real push; `--no-verify --verify` keeps hooks on).
  - A unique prefix reads as the option it abbreviates (`--al`, `--mirro`, `--branc`, `--dry`, `--de`, `--no-verif`).
  - A value option takes the next word whether spelled in full or abbreviated, so `--recurse-submodules on-demand origin feature` no longer reads `on-demand` as the remote.
  - An ambiguous or unknown spelling, which git rejects, counts for every denying reading (force, whole-repo, `--no-verify`) and for no passing one (dry-run, delete, tags).
- git-guard F-force-push counts `--mirror` and `remote.<name>.mirror` as a force push. The setting is read the way the push reads it: stored config, the command's `-c` and `--config-env` overrides, and the `GIT_CONFIG_*` variables in its environment, on the named remote or the push remote git resolves. A setting git cannot read (a run-time value, an unset `--config-env` variable) counts as a mirror. ship-gate judges a push to a mirror remote, named or resolved, as a whole-repo push.
- git-guard F-hookskip denies an abbreviated `--no-verify` (`--no-verif`, `--no-ver`) on commit and merge.
