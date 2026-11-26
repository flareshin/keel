### Fixed

- model-assign keeps the frontmatter `model:` pin of an agent defined in the project's `.claude/agents` (found from the git toplevel of the payload cwd, and preferred over a user agent of the same name) and of another installed plugin's agent (`<plugin>:<name>`, read from `installed_plugins.json`). Before, these dispatches were rewritten or denied toward sonnet.
