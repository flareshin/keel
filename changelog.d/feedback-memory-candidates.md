### Fixed

- Smoke's rule-of-two note now picks a feedback memory by `type: feedback` in its frontmatter (top level or under `metadata`) instead of a `feedback_` file-name prefix. Claude Code's newer kebab-case memory names carry no prefix, so those feedback memories were left out of the incident-candidate list.
