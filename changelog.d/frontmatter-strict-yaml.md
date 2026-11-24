### Fixed

- The `deepening-prompts` and `removing-comments` descriptions no longer contain `: ` in an unquoted value, so their frontmatter parses under strict YAML (Ruby Psych reported "mapping values are not allowed"). `tests/skills/skill-files.test.ts` now rejects a plain frontmatter value with `: `, ` #`, a trailing `:` or a leading YAML indicator in every skill and agent file.
