# keel

keel is a Claude Code plugin that makes an agent prove its work before it ships. The agent that writes a change cannot declare it reviewed, tested or approved: a separate reviewer judges the diff, test runs leave evidence tied to the exact tree, and a hook refuses the push or merge until the review, the tests and the owner's approval all cover what is going out.

keel is written almost entirely by AI agents and ships through its own gate. It is at release 1.0.0 ([`CHANGELOG.md`](CHANGELOG.md)) and licensed under the Apache License 2.0 ([`LICENSE`](LICENSE)); [`NOTICE`](NOTICE) carries the notices of the third-party material it adapts. The binding spec is [`docs/DESIGN.md`](docs/DESIGN.md); where this README and the spec disagree, the spec wins.

## Why

Agent harnesses tend to fail in three ways:

- **Self-judged work.** The agent that wrote a change also says it is done and correct.
- **Unverifiable claims.** "Tests pass" or "reviewed" appears in a message, and nothing machine-checkable backs it.
- **Rule accretion.** Every incident adds prose to the instructions. Nobody measures whether it works, and nothing ever leaves.

keel holds each rule at the strongest layer that can hold it, in this order: a check in the target repo, a hook, a skill, plain prose. Hooks decide what a script can decide, such as denying a push without review evidence. Every rule is a row in a [ledger](ledger.tsv) with a metric and a review date, and a rule whose metric counts nothing is proposed for demotion and, in the end, retirement.

## How a change ships

```
worktree ──► change + tests ──► keel test ──► lens-review ──► keel approve ──► push / merge
                                   │               │                │                │
                              tests evidence  review evidence  approval evidence  ship-gate checks all
```

1. **Work in a worktree.** A session edits only in its own worktree; keel's own checkout, which the plugin reads, moves only by merge.
2. **Run tests through keel.** `keel test -- <cmd>` runs the command, reads the runner's summary and writes tests evidence for the exact tree. A non-zero exit, a count of 0 or a tree that changed during the run writes none.
3. **Review in a separate context.** `/keel:lens-review` runs independent auditors over a snapshot of the tree. A verifier checks each finding, and a reporter emits `VERDICT: PASS` or `VERDICT: NEEDS_FIXES` with a `KEEL-EVIDENCE` line. A hook, not the reviewer, writes the review evidence. Fixes are reviewed as deltas on the same chain.
4. **The owner approves.** The owner runs `keel approve <root_run_id>` in their own terminal; agents are denied it. The approval pins the chain's current head.
5. **ship-gate decides.** On `git push` and `gh pr merge`, every outgoing path must match, blob for blob, a reviewed chain with matching tests evidence and, at merge, the approval. A denial names what is missing.

How much verification a change needs follows its risk class, which the gated repo's path rules decide: smoke-only data paths need smoke evidence; light, standard and heavy paths need a review, tests where required, and approval at merge. [`docs/review-policy.md`](docs/review-policy.md) has the review flow.

## Install

Requirements: Claude Code, `node` 24 or newer, `bash`, `git` and `jq`.

Run these from a terminal outside Claude Code. git-guard denies an agent the commands that change keel's links or the installed plugins, because they change the hooks every session runs.

```bash
git clone https://github.com/flareshin/keel ~/git/keel
cd ~/git/keel
claude plugin marketplace add ~/git/keel
claude plugin install keel@keel
bin/link --plugin
bin/link --write --plugin
bin/link --check
```

- The plugin provides the hooks, skills, agents and workflows, and loads `PRINCIPLES.md` at the start of every session.
- `bin/link --plugin` alone is a dry run. `--write` then sets the `permissions` and `env` keys of `~/.claude/settings.json` and links the `keel` CLI at `~/.claude/bin/keel`. Add `~/.claude/bin` to your `PATH`.
- On an existing setup, `--write` refuses until you accept the settings it would replace; the refusal prints the command to run. See [`docs/install.md`](docs/install.md).
- Start a new Claude Code session. Skills and workflows carry the `keel:` prefix, for example `/keel:lens-review`.

keel is read from `~/git/keel` in place, so keep that checkout clean and move it only by merge or `git pull --ff-only`, then start new sessions. Once keel is installed, git-guard denies Claude Code writes in it.

## Gate a repo

Gates apply only to the repos you register. Without an overlay, no repo is gated and ship-gate only warns.

The overlay, `~/git/keel-overlay`, is a private directory for your own data: gated repos, path risk rules, personal rules, known secret values. Every file in it is optional. Create `~/git/keel-overlay/gated-repos.tsv` from your own terminal, tab-separated:

```
origin	gate	integration_base	risk_rules	tests	push_approval
you/your-repo	code	main	-	required	false
```

`risk_rules` `-` classes test paths as `light` and everything else as `standard`. To class paths as `light`, `heavy` or `smoke-only`, add a rule set to `risk-rules.tsv` and name it in that column. [`examples/`](examples) shows the overlay's files with invented values, and DESIGN.md (h) specifies them.

Then, in a Claude Code session in that repo: work in a worktree, run `keel test -- <your test command>`, review with `/keel:lens-review`, approve from your own terminal with `keel approve <root_run_id>`, and push.

## What is included

### Hooks

| Hook | Runs on | Enforces |
|---|---|---|
| `ship-gate` | Bash | Review, tests and approval evidence for `git push` and `gh pr merge` |
| `git-guard` | Bash, Edit, Write, NotebookEdit | No secrets, AI attribution, force push to shared branches, hook skipping, or edits in the live keel and overlay checkouts; keel's own evidence and install stay out of an agent's reach |
| `report-gate` | Subagent handback and stop | Done or pass claims carry evidence; writes review evidence from a reviewer's report |
| `model-assign` | Agent, Workflow | Every agent dispatch names a model and an effort: it fills them in on an Agent call that names none and denies a Workflow script whose `agent()` calls name none |
| `principles` | Session and subagent start | Loads `PRINCIPLES.md` and the overlay's `PERSONAL.md` |

`ship-gate` and `git-guard` block the call if they crash or time out; the others fail open. Every decision is logged to `~/.claude/logs/keel-fires.jsonl`, which the ledger's metrics count.

### Skills, workflows and agents

| Name | Purpose |
|---|---|
| `lens-review`, `adversarial-audit` | The review engine: independent lenses, finding verification, a verdict with evidence |
| `refining-requests` | Turns an ambiguous request into a brief, asking only what changes the work |
| `writing-readable-code` | Rules for code a person can follow, with a script for rule signals |
| `removing-comments` | A comment pass by a context that did not write the comments |
| `improving-structure` | One structural improvement or a specified refactoring, with behavior pinned before and after |
| `descending-findings` | Moves a recurring review finding to a stronger layer, such as a lint rule |
| `authoring-agents`, `improving-agents`, `deepening-prompts` | Writing and improving agent definitions and prompts |
| `auditor`, `reporter`, `comment-reviewer` | Tool-limited agent types the workflows dispatch |

### The `keel` CLI

| Command | Purpose |
|---|---|
| `keel test -- <cmd…>` | Run tests and write tests evidence |
| `keel snapshot <repo>` | Write the working tree to a tree object for reviewers to read |
| `keel approve <root_run_id> [--read]` | Owner-only approval of a review chain (`--read` only acknowledges) |
| `keel approve --promote <owner/repo> <sha>` | Owner-only approval of one develop→production merge of that sha; develop chains need only their PASS |
| `keel evidence show [--repo] [--root]` | Read-only view of chains, tests and smoke evidence |
| `keel evidence check --repo` | Read-only: would ship-gate let a push of HEAD through; exit 1 lists what is missing |
| `keel evidence promote-plan --repo --base --head` | Read-only: which develop chain covers each promoted step, and the runs left to review |
| `keel evidence gc` | Delete expired evidence (review, approval and promote after 30 days; tests, smoke and ack after 14) |

Evidence lives under `~/.claude/state/keel/evidence/` as immutable JSON files.

## Principles and the ledger

[`PRINCIPLES.md`](PRINCIPLES.md) is the charter every session loads:

| ID | Principle |
|---|---|
| K1 | An author never judges its own output. |
| K2 | Every done or pass claim carries machine-verifiable evidence. |
| K3 | Changed logic ships with tests in the same diff. |
| K4 | Ask when ambiguous; act when clear. |
| K5 | Make only needed, readable changes. |

It also states the risk rule and the floor rules the hooks hold: merge, deploy and delete need explicit approval, and no secrets, AI attribution, force push to shared branches or switched-off hooks.

[`ledger.tsv`](ledger.tsv) has one row per rule, with where it is enforced, its metric and its review date. A rule outside the charter and floor needs two incidents behind it, and the counts are capped, so the rule set stays small. `measure/smoke` checks the whole harness, `measure/run <id>` evaluates one row's metric, and `measure/propose` proposes demotions for expired rows; the owner edits the ledger.

## Limits

The hooks stop an honest agent's mistakes and shortcuts, not deliberate evasion: no parser over arbitrary shell is complete. A push or merge the shell parser cannot attribute to one repo and branch is denied rather than guessed. The final guard is branch protection on your integration branches, and a person working in their own terminal is the intended escape hatch. DESIGN.md §5.7a has the threat model, and §8 lists what keel deliberately does not do.

## Layout

```
PRINCIPLES.md  ledger.tsv     principles and the keel ledger
bin/           keel, link, changelog  evidence CLI, link/merge tool, release changelog folder
hooks/         core hooks     plus hooks/lib/hookkit (shell parser, shared helpers)
lib/           evidence/, link/, changelog/
measure/       run, smoke, propose, boundary, weekly, evals/
githooks/      pre-commit, pre-push (boundary scan)
settings/      core.json (hook registration), links.tsv (link manifest)
stacks/        spring-maven/ (env-preflight hook, settings fragment)
skills/        refining-requests/, writing-readable-code/, descending-findings/, improving-structure/, removing-comments/, authoring-agents/, improving-agents/, deepening-prompts/
workflows/     lens-review.js, adversarial-audit.js, review-lenses.json
agents/        auditor.md, reporter.md, comment-reviewer.md (tool-limited review agent types)
codex/         Codex adapter
docs/          DESIGN.md (binding spec), review-policy.md, codex-review.md, install.md, testing.md
examples/      overlay-shaped sample data with invented values
tests/         one directory per component, plus run-all.sh
changelog.d/   one changelog fragment per branch; CHANGELOG.md [Unreleased] only points here
```

## More

- [`docs/install.md`](docs/install.md): `bin/link` in detail, running without an overlay, the link-only install and upgrades.
- [`docs/testing.md`](docs/testing.md): running keel's own tests (`bash tests/run-all.sh`).
- [`codex/`](codex): an adapter that installs the same charter, core skills, guards and overlay into Codex.

## Contributing

Contributions come only as pull requests against `main`. Only the owner (flareshin) reviews and merges them, and direct pushes to `main` are blocked for everyone else.

keel is licensed under the Apache License 2.0 ([`LICENSE`](LICENSE)).

## Acknowledgements

These published skills shaped keel's own skills:

| keel skill | Influenced by | What it took |
|---|---|---|
| `improving-structure` | Matt Pocock's [`improve-codebase-architecture`](https://github.com/mattpocock/skills) and [`codebase-design`](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md) (at 49dd158, MIT) | The module, interface and depth vocabulary and the deletion test |
| `improving-structure` | pstack in [cursor/plugins](https://github.com/cursor/plugins) (at 6b78e9f, MIT) | The subtract-before-you-add and migrate-callers ordering rules |
| `removing-comments` and the `comment-reviewer` agent | pstack `no-comments` and Comment Sicko in [cursor/plugins](https://github.com/cursor/plugins) (at 4dd1d05, MIT) | A comment pass by a context that did not write the comments, with reshape flags for surprises in our own code and an encoding offer for claimed constraints; keel keeps its narrower K5.14 exceptions |
| `writing-readable-code` (rules K5.7, K5.8, K5.10 and `references/typescript-types.md`) and `improving-structure` (friction questions) | pstack `typescript-best-practices`, `principle-type-system-discipline`, `principle-model-the-domain`, `principle-minimize-reader-load` and `architect/references/design-red-flags.md` in [cursor/plugins](https://github.com/cursor/plugins) (at 4dd1d05, MIT) | The TypeScript type-design reference, lifecycle state as one value, domain-grouped modules, hand-synced lists and the 30-second reader test |
| `writing-readable-code` (implementation guide) | Matt Pocock's `codebase-design`, Addy Osmani's [`incremental-implementation`](https://github.com/addyosmani/agent-skills/blob/main/skills/incremental-implementation/SKILL.md) and [pstack `architect`](https://github.com/cursor/plugins/blob/main/pstack/skills/architect/SKILL.md) (read on 2026-10-19) | Caller-first design and small behavior slices |
| `authoring-agents` and `improving-agents` | [Harness²](https://github.com/google-research/harness2) (at 1cfe254, Apache-2.0, `harness2/core/prompts.py`) | The form order and "large input, small answer" test; the diagnosis split, verdict labels and cue/lesson/evidence entry |
| `deepening-prompts` | Felix Rieseberg's ["How to be more ambitious: a tutorial for humans with models"](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) (read on 2026-11-04) | The deeper-not-bigger rewrite: the outcome behind the task, the rawest source, expert methods, an outside judge, the doubt that attacks the result, verbs over nouns and a crew of roles asked for their work, not their voice |

The skill files name their sources too.
