### Added

- ship-gate and git-guard also run on `PreSkillShellCommand` (Claude Code 2.1.332), so a skill's or command's injected shell command (`` !`…` ``) is held to the same push, merge and git rules as a Bash call. Before, those commands ran while the skill loaded without any PreToolUse hook seeing them. Builds up to 2.1.331 never call the event and still run injected commands unchecked.
