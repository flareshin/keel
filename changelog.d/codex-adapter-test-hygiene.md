### Changed

- The Codex runtime guidance and `codex/README.md` no longer list the retired `handoff` hook as unregistered, and name `env-preflight` as an example of the stack hooks Codex does not register. A new `codex/tests/ledger-hooks.test.ts` checks that every hook a counted ledger row is enforced by is either run by the Codex guard or named as unregistered in `codex/AGENTS.md`, and that the guidance names no hook the ledger no longer uses.

### Fixed

- Codex adapter tests derive the core skill list from `skills/` instead of a hand-kept list of eight names, check that a renamed skill is linked under its new name only, and run `git` with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` so the developer's git config cannot change their results. The owner-command test compares the installed guidance with the rule line of `codex/AGENTS.md` and checks that dropping the line drops it from the install; the stdin tests vary locale settings instead of Python encoding variables, which the Node hook never read.
