### Fixed

- A `contract-miss` fires line now starts its detail with `cc_version`, ahead of the missing fields, context and received keys. Before, the 200-character detail limit cut the version off every SubagentStop miss, so none of the 4,995 logged misses said which Claude Code version they came from.
