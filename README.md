# keel

A small, measured harness for Claude Code. It has five principles. Each one is enforced at the strongest layer that can hold it (repo > hook > skill > prose), and every rule enters and leaves through a ledger row.

keel is written almost entirely by AI agents. Every change is reviewed by a separate agent context that did not write it (`lens-review`), and keel ships through its own ship-gate, which merges only with the owner's approval.

Status: not yet public. No license has been chosen yet, so all rights are reserved for now. The binding spec is `docs/DESIGN.md`.

## What it does

- `PRINCIPLES.md`: the charter (K1–K5), the `risk` experiment and the floor rules the agent must read (`F-mod-trust` is a smoke check only; see `ledger.tsv`). `bin/link` generates the user-level `CLAUDE.md` from it.
- `ledger.tsv`: one row per rule, giving its layer, where it is enforced, its metric and its review date. Company rows live in a separate private overlay ledger.
- Hooks: `ship-gate` (push and merge gate based on review, test and approval evidence), `git-guard` (attribution, secrets, force push, evidence protection), `report-gate` (evidence in done/pass claims, review evidence writing), `model-assign`, `handoff`, plus `env-preflight` for the `spring-maven` stack.
- `bin/keel`: the evidence CLI (`test`, `approve`, `snapshot`, `evidence …`).
- `measure/`: the metric runner, smoke checks, demotion proposals, the weekly report and the public-boundary scanner.
- `skills/`: `prompt-refine` (K4), `readable-code` (K5), `descend`.
- `workflows/`: `lens-review` and `adversarial-audit`.

## Layout

```
PRINCIPLES.md  ledger.tsv     principles and the keel ledger
bin/           keel, link     evidence CLI, link/merge tool
hooks/         core hooks     plus hooks/lib/hookkit
lib/           evidence/, link/
measure/       run, smoke, propose, boundary, weekly
githooks/      pre-commit, pre-push (boundary scan)
settings/      core.json (hook registration), links.tsv (link manifest)
stacks/        spring-maven/ (env-preflight hook, settings fragment)
skills/        prompt-refine/, readable-code/, descend/
workflows/     lens-review.js, adversarial-audit.js, review-lenses.json
examples/      overlay-shaped sample data with invented values
tests/         one directory per component, plus run-all.sh
```

Settings fragments use `{{KEEL}}`, `{{OVERLAY}}` and `{{DATA}}` placeholders. `bin/link` expands them and replaces only the `hooks`, `permissions` and `env` keys of `settings.json`. `bin/link` with no arguments is a dry run (it also lists the settings items a first `--write --adopt` would drop), `--check` reports drift, and `--write` applies the changes.

## Running the tests

Requirements: `python3` (3.9+, stdlib only), `bash`, `git`, `jq`, `node`.

```bash
bash tests/run-all.sh
```

Tests run in temporary directories (`KEEL_DATA_DIR`, `KEEL_OVERLAY_DIR`, `HOME`). They never touch the network or a real `~/.claude`. To run a single component:

```bash
python3 -m unittest discover -s tests/ship-gate -t tests/ship-gate -v
node --test 'tests/workflows/*.test.mjs'
```

To enable the boundary-scan git hooks in a checkout, run `git config core.hooksPath githooks`.
