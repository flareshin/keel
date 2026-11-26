### Fixed

- model-assign reads a project agent's `model:` pin from every `.claude/agents` directory on the path from the payload cwd up to the repository root, closest first, as Claude Code discovers project subagents. Before, only the repository root's `.claude/agents` was read, so a pin in a nested directory (a monorepo package) was rewritten or denied toward sonnet.
