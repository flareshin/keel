### Fixed

- `measure/evals/eval` counts keel as live under the plugin install. With `link-state.json` recording `"mode": "plugin"`, keel is live when `enabledPlugins` holds `"keel@keel": true` and the keel checkout serves the skill's `SKILL.md` and `PRINCIPLES.md`; before, plugin mode always read as not live and every full run wrote `<id>-v1baseline`. The run's `config.json` gains `link_mode` and `principles_md_sha256`, and under the plugin install `skill_md_sha256` hashes the checkout's skill file.
- `measure/evals/review-eval` hashes the reviewer workflows in the keel checkout under the plugin install, where `<config dir>/workflows` no longer holds them; the reviewer fingerprint was all null there.
