# keel

A small, measured harness for Claude Code. It has five principles. Each one is enforced at the strongest layer that can hold it (repo > hook > skill > prose), and every rule enters and leaves through a ledger row.

keel is written almost entirely by AI agents. Every change is reviewed by a separate agent context that did not write it (`lens-review`), and keel ships through its own ship-gate, which merges only with the owner's approval.

keel is public, at release 1.0.0 (see [`CHANGELOG.md`](CHANGELOG.md)); no license has been chosen, so all rights remain reserved. The binding spec is [`docs/DESIGN.md`](docs/DESIGN.md); where this README and the spec disagree, the spec wins.

## Why keel exists

An agent harness tends to fail in three ways:

- **Self-judged work.** The agent that wrote a change also declares it done and correct.
- **Unverifiable claims.** "Tests pass" or "reviewed" appears in a message, but nothing machine-checkable backs it.
- **Rule accretion.** Every incident adds a paragraph of prose to the instructions. The prose grows, nobody measures whether it works, and nothing ever leaves.

keel answers these with a few rules held by code where possible:

- Hooks hold rules that a script can decide, such as blocking a push without review evidence.
- Every rule is a row in a ledger. The row says where the rule is enforced, how it is measured and when it is reviewed again.
- A rule that stops earning its place is proposed for demotion and, eventually, retirement.

## Getting started

This takes a new user from a clone to a first gated push. It needs `node` 24 or newer, `bash`, `git` and `jq`. The later sections explain each part.

### 1. Clone a dedicated checkout

```bash
git clone <keel repo url> ~/git/keel
```

`bin/link` points `~/.claude` into this checkout, so it should move only by merge: update it from your own terminal with `git -C ~/git/keel pull --ff-only`, then run `~/git/keel/bin/link --check`; if it reports drift, run `~/git/keel/bin/link --write` and check again. Do not edit in it. Once keel is installed, git-guard denies Claude Code writes there and asks for a worktree (`C-isolation`). `bin/link --write` refuses to link from a linked worktree.

### 2. Start without an overlay

The overlay (`~/git/keel-overlay`, or `KEEL_OVERLAY_DIR`) holds your own rules and data. Every file in it is optional, so you can start without one. Until you add one:

- No repo is gated. ship-gate warns once per session and lets pushes and merges through, except one it cannot attribute to one repo and branch, such as `git subtree push` or a `GIT_DIR` override, which it still denies.
- `git-guard`, `report-gate` and `model-assign` still run in every repo. For example, `model-assign` assigns a model and an effort to an agent dispatch that names none, and denies a Workflow script whose `agent()` calls name none.
- The generated `CLAUDE.md` holds `PRINCIPLES.md` only.
- `measure/smoke` fails until the overlay has `boundary/lexicon.txt`, and while any installed Claude Code mod is missing from the overlay's `reviewed-mods.txt`.

[`examples/`](examples) shows sample data for the main overlay files, grouped by component, with invented values. DESIGN.md (a) lists every overlay file.

### 3. Link it into `~/.claude`

Run these from a terminal outside Claude Code:

```bash
cd ~/git/keel
bin/link
```

This dry run prints JSON: `actions` (what `--write` would do), `problems` and `dropped`. With no existing `~/.claude` setup nothing blocks:

```bash
bin/link --write
bin/link --check
```

With an existing setup, one or both of two problems block `--write`. A refused `--write` writes nothing and prints the exact command to run after `link: or, once each one is reviewed, run:`.

- `target-occupied` on `CLAUDE.md`: the file is yours, not generated. `--force` moves it to `~/.claude/state/keel/link-backup/<time>/CLAUDE.md`. To keep its rules, move them into the overlay's `PERSONAL.md`; `bin/link` appends that file to the generated `CLAUDE.md`. The generated file is capped at 4608 bytes and `PRINCIPLES.md` uses about half, so `PERSONAL.md` has about 2.3 KB; no flag lifts the cap, and the dry run's `claude_md_bytes` shows the size.
- `settings-unadopted`: keel takes over the `hooks`, `permissions` and `env` keys of `settings.json`, and `dropped` lists every existing item it would remove. To keep an item, declare it in an overlay settings fragment, such as `~/git/keel-overlay/settings/mine.json`, with the same key and value as in your `settings.json`. A plain `bin/link --write` refuses, writes nothing and prints each item on stderr as `link: adopt drops: <item>`. Copy each item you accept losing into a file, one per line, exactly as those lines print it (the JSON in `dropped` escapes quotes and backslashes).

With both problems, that command is:

```bash
bin/link --write --adopt --force --accept-drops <file>
bin/link --check
```

Other settings keys, such as `model`, stay as they are. The `keel` CLI is linked at `~/.claude/bin/keel`; add `~/.claude/bin` to your `PATH` so that you and Claude Code can run `keel`. Start a new Claude Code session so the hooks, skills and `CLAUDE.md` load. `bin/link --unlink` restores the backed-up `settings.json` and `CLAUDE.md`; ignore the `v1-final` restore command it prints unless you used keel v1.

### 4. Gate your first repo

From your own terminal, create `~/git/keel-overlay/gated-repos.tsv`, tab-separated, with your repo's `owner/repo`. Create and edit overlay files there, not through Claude Code: git-guard treats the overlay like the keel checkout and denies Claude Code writes in it. The file looks like this:

```
origin	gate	integration_base	risk_rules	tests	push_approval
you/your-repo	code	main	-	required	false
```

`risk_rules` `-` means no rule set, so test paths are classed `light` and every other path `standard`. To class paths as `light`, `heavy` or `smoke-only`, add rows under a set name to `risk-rules.tsv` and put that set name in the repo's `risk_rules` column. DESIGN.md (h) specifies both files.

### 5. Ship a first change

In a Claude Code session in that repo:

1. Work in a worktree, not the main checkout.
2. Run the tests through keel, for example `keel test -- npm test`. The run must report a nonzero test count.
3. Review with `/lens-review`. Its report starts with `VERDICT: PASS` or `VERDICT: NEEDS_FIXES` and carries a `KEEL-EVIDENCE` line that names the chain's `root_run_id`. Fixes are reviewed as deltas on the same chain.
4. Approve from your own terminal: `keel approve <root_run_id>`. Agents are denied this command. `keel evidence show --repo <path>` lists the repo's chains.
5. Push and open or merge the PR. ship-gate checks the evidence. A denial names the missing piece and, where needed, the command for your own terminal.

## Principles

The charter lives in [`PRINCIPLES.md`](PRINCIPLES.md). `bin/link` turns it into the user-level `CLAUDE.md`.

| ID | Principle | Strongest layer today |
|---|---|---|
| K1 | An author never judges its own output. | hook (`ship-gate`) |
| K2 | Every done or pass claim carries machine-verifiable evidence. | hook (`report-gate`) |
| K3 | Changed logic ships with tests in the same diff. | hook (`ship-gate`) |
| K4 | Ask when ambiguous; act when clear. | skill (`prompt-refine`) |
| K5 | Make only needed, readable changes. | skill (`readable-code`) |

`PRINCIPLES.md` also states:

- **`risk`**: how much verification each risk tier needs, and that merging or a deploying push needs the owner's `keel approve`. DESIGN.md §1 frames `risk` as a core experiment: verification weight is proportional to risk. In the ledger it is a core-scope row with a review date; the pilot in DESIGN.md §6.1 decides whether it becomes charter.
- **Floor rules**: hook-enforced safety limits. `F-irreversible` (merge, deploy and delete need explicit approval), `F-secrets`, `F-attribution`, `F-force-push` and `F-hookskip` (never switch hooks off).

One more floor row is not in `PRINCIPLES.md`: `F-mod-trust` (every installed Claude Code mod is reviewed), which the ledger and DESIGN.md §1 state. It is a prose-layer row with no hook behind it. The smoke `mod-trust` check FAILs on an unreviewed mod; the row's own metric only checks that this smoke check exists.

## Enforcement ladder

```
repo  >  hook  >  skill  >  prose
```

- **repo**: a lint rule, architecture test or CI test in the target repository. Strongest, because it binds every author, human or agent.
- **hook**: a Claude Code hook script in keel that allows, warns about or denies a tool call.
- **skill**: instructions the agent loads for a task. Used where the rule needs judgment.
- **prose**: plain text in a document. Weakest.

A rule enters at the strongest layer that can hold it. A `skill` or `prose` row must say why it cannot be stronger (`why_not_stronger`). The `descend` skill moves a recurring review finding down the ladder, for example into a lint rule in the target repo. keel's own text for that rule is then deleted.

## The ledger

[`ledger.tsv`](ledger.tsv) holds one row per rule: its id, scope, statement, layer, `enforced_at`, metric, incidents, `review_by` date and status. The format is specified in DESIGN.md §4 and (b).

- **Ids.** `K*` = charter, `risk`, `C-*` = core, `S-*` = stack, `O-*` = overlay, `F-*` = floor. Every rule line in a rule location (`PRINCIPLES.md`, the overlay's `PERSONAL.md`, the rules section of each `SKILL.md`, every hook message) carries its `[ID]`, and smoke checks this.
- **Rule of two.** A non-charter, non-floor row needs at least two distinct incidents behind it.
- **Metric.** Every active row has a metric that `measure/run` evaluates, such as counting the hook's firings, running an eval or checking that a file exists in a repo. A metric that recognized zero items fails.
- **Expiry.** Rows carry a `review_by` date. `measure/propose` looks at expired rows. A row whose metric counted nothing is proposed one layer weaker (`hook` → `skill` → `prose` → retired). A row that counted something gets 60 more days. Proposals are printed only; the owner edits the ledger.
- **Caps.** Charter ≤ 7 rows, core ≤ 10 (floor rows excluded), each stack ≤ 10, overlay ≤ 15, hook scripts ≤ 8, and the generated `CLAUDE.md` ≤ 4608 bytes. Growth is visible and bounded.

## Three places: keel, overlay, data

| Location | Visibility | Holds |
|---|---|---|
| `~/git/keel` (this repo) | public goal | The method: principles, ledger engine, hooks, ship-gate, review engine, measurement, skills, stacks and example data with invented values |
| `~/git/keel-overlay` (`KEEL_OVERLAY_DIR`) | private | Company and personal data: the owner's `PERSONAL.md` rules, the overlay ledger, gated-repo registry, risk path rules, boundary lexicon, known secret values, private skills and scheduled tasks |
| `~/.claude` (`KEEL_DATA_DIR`) | private | Data only: transcripts, memory, logs, evidence and state. Harness paths in it are symlinks or files generated by `bin/link` |

Why the split:

- **keel can be published; company data must not be.** Company rules, repository names and incident records go only in the overlay. Company rules are rows in the overlay's own ledger, and smoke checks the union of both ledgers.
- **A scanner guards the boundary.** `measure/boundary` checks added lines and commit messages against the overlay's private lexicon and regexes and against generic secret patterns (`measure/boundary-generic.tsv`). The `pre-commit` and `pre-push` hooks in `githooks/` run it, and smoke fails if the lexicon is missing.
- **Method and data stay separate.** keel holds the engine; the overlay decides where it applies. Anyone can pair keel with an overlay of their own. Every overlay file is optional, and a missing file means no data. [`examples/`](examples) shows the overlay's shape with invented values.

## How a change ships

```
worktree ──► change + tests ──► keel test ──► lens-review ──► keel approve ──► push / merge
                                   │               │                │                │
                              tests evidence  review evidence  approval evidence  ship-gate checks all
```

1. **Work in a worktree.** `C-isolation`: a session edits only in its own worktree. The live checkouts, which the links point at, move only through an approved fast-forward merge.
2. **Run tests through keel.** `keel test -- <cmd>` runs the command, parses the runner summary (`Ran N tests`, `Tests run: N`, `N passed`, TAP) and writes tests evidence tied to the exact tree. It writes none if the exit code is non-zero, the count is 0 or the tree changed during the run.
3. **Review in a separate context.** The `lens-review` workflow runs independent auditors over a snapshot tree (`keel snapshot`), never the live working tree. Auditors and verifiers run as the tool-limited `keel-auditor` agent type, the reporter as `keel-reporter` (`agents/`), and audit effort follows the diff's risk class. A separate verifier checks each finding's reproduction, and a reporter agent emits a report starting with `VERDICT: PASS` or `VERDICT: NEEDS_FIXES`, plus one `KEEL-EVIDENCE:` line per repo. The `report-gate` hook writes the review evidence; the reviewer cannot. A reviewer whose transcript shows a file write counts as an author and yields no evidence.
4. **Fix with deltas.** Fixes after a review are reviewed as a delta on the same chain (`root_run_id`), not as a new full review.
5. **The owner approves.** The owner runs `keel approve <root_run_id>` in their own terminal. Agents are denied this command. The approval is pinned to the chain's current head, so a later delta needs a new approval. `--read` records an acknowledgement only and approves nothing.
6. **ship-gate decides.** On `git push` and `gh pr merge`, ship-gate computes the outgoing diff from the merge base. Unless the whole diff is smoke-only (below), every outgoing path must appear, with the same blob and mode, in one reviewed evidence chain, or in an approved series of chains, together with matching tests evidence and, at merge, the approval. A blob that differs from the reviewed or tested one only by deleted comments that meet the comment-only deletion rule of DESIGN.md §5.4 still matches (§5.1).

`docs/review-policy.md` specifies the review flow and what an approval request must explain. Approval and a PASS are evidence, not consent to open a PR.

### Risk classes

ship-gate classifies the outgoing paths with the overlay's `risk-rules.tsv`; evidence never states its own risk. When a rule is ambiguous, the heavier class wins.

| Class | Typical paths | Required |
|---|---|---|
| smoke-only | data, prompt and settings-fragment paths | smoke evidence covering the diff |
| light | copy, style, docs, config | `lens-review` chain; tests if the repo requires them; approval at merge |
| standard (default) | anything no rule matches | `lens-review` chain + tests; approval at merge |
| heavy | money, inventory writes, schema, batch, external contracts | `lens-review` chain + tests; approval at merge |

K3 also applies: a logic path with no test path in the same range is denied, unless the chain head's `KEEL-EVIDENCE` carries a `no_test_reason` (lens-review does not emit it yet), or the path's change only deletes ordinary whole-line comments. DESIGN.md §5.4 defines both.

### Threat model

The hooks stop an honest agent's mistakes and shortcuts. A push or merge that the shell parser cannot attribute to one repo and branch is denied, not guessed. keel does not try to stop deliberate evasion, because no parser over arbitrary shell can be complete. The final guard is branch protection on the integration branches. A person pushing from their own terminal is the intended escape hatch. Details are in DESIGN.md §5.7a.

## Components

### Hooks

Registered in [`settings/core.json`](settings/core.json). `ship-gate` and `git-guard` are registered with `onFailure: "block"`, so a crash or timeout blocks the call; the other hooks fail open.

| Hook | Event | Enforces |
|---|---|---|
| `ship-gate` | `PreToolUse` Bash | K1, K3, `risk`, `F-irreversible`: review, tests and approval evidence for push and merge |
| `git-guard` | `PreToolUse` Bash, Edit, Write, NotebookEdit | `F-secrets`, `F-attribution`, `F-force-push`, `F-hookskip`, `C-isolation`; protects evidence and fires logs |
| `report-gate` | `PreToolUse` SubagentHandback, `SubagentStop` | K2 (evidence in done/pass claims); writes review evidence from a reviewer's report |
| `model-assign` | `PreToolUse` Agent, Workflow | `C-dispatch`: every agent dispatch names a model and an effort |
| `env-preflight` | `PreToolUse` Bash (stack fragment, registered when the overlay's `stacks.txt` lists `spring-maven`) | `S-jdk`: Maven builds pin the JDK the repo requires |

Each decision is logged to `$KEEL_DATA_DIR/logs/keel-fires.jsonl`: a deny or warn writes one line per `[ID]` in its message, a pass one line, and a call that is no decision (for example a Bash command that is no push, merge or protected write) nothing. Ledger metrics count these lines.

### The `keel` CLI

| Command | Purpose |
|---|---|
| `keel test -- <cmd…>` | Run tests and write tests evidence (also one per unchanged submodule) |
| `keel snapshot <repo>` | Write the working tree to a tree object without touching the index; reviewers read this |
| `keel approve <root_run_id> [--read]` | Owner-only approval (or acknowledgement) of a review chain's heads |
| `keel evidence show [--repo] [--root]` | Read-only view of chains, tests and smoke evidence |
| `keel evidence write-review` | Run by `report-gate` from a reviewer's report; agents are denied it |
| `keel evidence write-smoke` | Run by the job after a passing `measure/smoke`, before a smoke-only push |
| `keel evidence gc` | Delete expired evidence (14 days) |

Evidence lives under `$KEEL_DATA_DIR/state/keel/evidence/` as immutable JSON files (DESIGN.md (c)).

### Skills and workflows

- `prompt-refine` (K4): turns an ambiguous request into an approved brief and asks only the questions that change the work.
- `readable-code` (K5): rules R1–R16 for code a person can follow. Its `scripts/rule-checks.ts` produces signals for the review's rule-checks lens.
- `descend`: moves a recurring finding to a stronger layer.
- `improve`: discover one structural improvement or carry out a specified refactoring, with a before/after behavior pin and equivalence evidence.
- `workflows/lens-review.js`: the review engine. Lenses, adversarial audit, verification, reporter.
- `workflows/adversarial-audit.js`: independent lens coverage plus batched finding verification.

### Measurement

- `measure/run <id>`: a row's metric. PASS, FAIL, or GRACE while a new row is in its grace period.
- `measure/smoke`: whole-harness checks, including ledger format, unique ids, caps, `[ID]` tagging, rule of two, metrics, the boundary scan, link integrity, wired fires (every hook row fires on its bad fixture), dangling links and mod trust.
- `measure/propose`: demotion, retirement and extension proposals for expired rows.
- `measure/weekly`: repo-layer rule count, always-loaded bytes, post-deploy defects, core size.
- `measure/evals/eval <id>`: behavioral evals through `claude -p` (today: K4), with train and holdout splits.
- `measure/evals/review-eval`: scores the reviewer itself (lens-review) on defect and clean cases: recall, noise and run-to-run variance.

## Install and link

keel never generates all of `settings.json`. It owns exactly the `hooks`, `permissions` and `env` keys. Settings fragments use `{{KEEL}}`, `{{OVERLAY}}` and `{{DATA}}` placeholders, which `bin/link` expands.

```bash
bin/link            # dry run: what would change; lists items a first --write --adopt would drop
bin/link --check    # report drift (exit 1 on any problem)
bin/link --write    # apply links, generated CLAUDE.md and owned settings keys
bin/link --unlink   # remove keel's links and restore the backed-up settings
```

- Links must point at a dedicated checkout that moves only by merge. `--write` refuses when `KEEL_HOME` is a linked worktree unless `--allow-worktree` is given.
- Every settings write is backed up first. A first write over existing settings needs `--adopt` and an `--accept-drops <file>` listing everything it would drop.
- `--write` also sets `core.hooksPath githooks` in the keel checkout, so the boundary scan runs on commit and push.

Environment variables (DESIGN.md (i)):

| Variable | Default | Meaning |
|---|---|---|
| `KEEL_HOME` | repo root of the running script | keel checkout |
| `KEEL_OVERLAY_DIR` | `~/git/keel-overlay` | overlay checkout; missing means no overlay data |
| `KEEL_DATA_DIR` | `~/.claude` | logs, state, evidence, link targets, settings |

### Upgrading from a release with Python hooks

1. Fast-forward the dedicated keel checkout (`~/git/keel`) to the 1.0.0 commit.
2. At once, from a terminal outside Claude Code and Codex, run `bin/link --write` and then `codex/bin/link --write` in
   that checkout. Both rewrite the hook registrations in the settings from `python3 .../<name>.py` to
   `node .../<name>.ts`.
3. Start a new Codex session, open `/hooks` and trust the regenerated `pre-tool-use.ts` command (see
   [`codex/README.md`](codex/README.md)).
4. Run `bin/link --check` and `codex/bin/link --check`. Both must report no drift.

Until step 2 is done, every keel hook blocks: the old settings still point at the `.py` files this release deletes, so
`python3` fails on each hook call. Run the two `link --write` commands from a terminal outside Claude Code and Codex,
whose blocked hooks would stop them.

### Codex

[`codex/`](codex) is an adapter that installs the same charter, core skills, guard scripts and overlay into Codex (`codex/bin/link`). See [`codex/README.md`](codex/README.md).

## Layout

```
PRINCIPLES.md  ledger.tsv     principles and the keel ledger
bin/           keel, link     evidence CLI, link/merge tool
hooks/         core hooks     plus hooks/lib/hookkit (shell parser, shared helpers)
lib/           evidence/, link/
measure/       run, smoke, propose, boundary, weekly, evals/
githooks/      pre-commit, pre-push (boundary scan)
settings/      core.json (hook registration), links.tsv (link manifest)
stacks/        spring-maven/ (env-preflight hook, settings fragment)
skills/        prompt-refine/, readable-code/, descend/, improve/, no-comments/
workflows/     lens-review.js, adversarial-audit.js, review-lenses.json
agents/        keel-auditor.md, keel-reporter.md, keel-comment-reviewer.md (tool-limited review agent types)
codex/         Codex adapter
docs/          DESIGN.md (binding spec), review-policy.md, codex-review.md
examples/      overlay-shaped sample data with invented values
tests/         one directory per component, plus run-all.sh
```

## Running the tests

Requirements: `node` 24 or newer (the `engines` field; tested on 26.12), `bash`, `git` and `jq`. keel does not use Python.

```bash
bash tests/run-all.sh
```

Tests run in temporary directories (`KEEL_DATA_DIR`, `KEEL_OVERLAY_DIR`, `HOME`). They never touch the network or a real `~/.claude`, except that `run-all.sh` holds the full-suite lock `$KEEL_DATA_DIR/state/keel/full-suite.lock` (default `~/.claude`) while it runs, so a second full run on the machine waits. To run a single component:

```bash
node --test 'tests/ship-gate/*.test.ts'
node --test 'tests/workflows/*.test.mjs'
npm ci   # once, before the typecheck
npx tsc -p tsconfig.json
```

No `py*.ts` module and no argparse clone is left; `measure`, `bin/link` and `lib/evidence` read JSON, paths, files, dates and command lines with plain Node behavior. Some Python semantics are kept on purpose in `hooks/lib/hookkit`, `codex/` and `skills/readable-code/scripts/rule-checks.ts`: the `splitlines` and `strip` character sets (`hooks/lib/hookkit/text.ts`, `apply_patch` text and guard output), CPython's recursion limit in the Codex TOML reader (`codex/lib/toml.ts`), the hooks' JSON spacing and error class names, and the exception names `rule-checks.ts` prints. The changelog's Unreleased section describes the ones that changed behavior.

The parity harnesses of the shell parser, `rule-checks`, and the Codex TOML port and path helpers compare the TypeScript with outputs recorded from the earlier Python implementation (Python 3.15.0, macOS) and stored as fixtures under `tests/fixtures/python` and `tests/skills/fixtures`. Each case whose outcome changed since is listed with the result it must give. The parity tests of the hooks, the ship-gate hook and the Codex adapter replay the recorded runs and payloads in `tests/hooks/fixtures`, `tests/ship-gate/fixtures` and `tests/fixtures/python/codex-{hook,cli}-parity` and compare the node code with a golden snapshot of its own output; `node tests/hooks/hook-parity-record.ts`, `node tests/ship-gate/ship-gate-parity-record.ts`, `node codex/tests/hook-parity-record.ts` and `node codex/tests/cli-parity-record.ts` re-record it. `measure`, `bin/link` and `lib/evidence` keep only the recorded outcomes (exit code, JSON fields, written files) in `tests/fixtures/measure`, `tests/fixtures/link` and `tests/fixtures/evidence`, and the Codex adapter keeps a golden snapshot of its input boundaries in `tests/fixtures/codex`, re-recorded with `node codex/tests/boundary-record.ts`. The Python recordings are frozen: the tools that recorded them needed the Python, which is gone, and survive only in the git history of the commits that introduced the fixtures. The Codex path test that resolves through `/tmp` and `/private` was recorded on macOS and skips on other platforms.

To enable the boundary-scan git hooks in a checkout, run `git config core.hooksPath githooks`.

## Contributing

Contributions come only as pull requests against `main`. Only the owner (flareshin) reviews and merges them, and direct pushes to `main` are blocked for everyone else.

## Acknowledgements

These published skills shaped keel's own skills:

| keel skill | Influenced by | What it took |
|---|---|---|
| `improve` | Matt Pocock's [`improve-codebase-architecture`](https://github.com/mattpocock/skills) and [`codebase-design`](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md) (at 49dd158, MIT) | The module, interface and depth vocabulary and the deletion test |
| `improve` | pstack in [cursor/plugins](https://github.com/cursor/plugins) (at 6b78e9f, MIT) | The subtract-before-you-add and migrate-callers ordering rules |
| `no-comments` and the `keel-comment-reviewer` agent | pstack `no-comments` and Comment Sicko in [cursor/plugins](https://github.com/cursor/plugins) (at 4dd1d05, MIT) | A comment pass by a context that did not write the comments, with reshape flags for surprises in our own code and an encoding offer for claimed constraints; keel keeps its narrower K5.14 exceptions |
| `readable-code` (implementation guide) | Matt Pocock's `codebase-design`, Addy Osmani's [`incremental-implementation`](https://github.com/addyosmani/agent-skills/blob/main/skills/incremental-implementation/SKILL.md) and [pstack `architect`](https://github.com/cursor/plugins/blob/main/pstack/skills/architect/SKILL.md) (read on 2026-10-19) | Caller-first design and small behavior slices |

The skill files name their sources too: `skills/improve/SKILL.md`, `skills/no-comments/SKILL.md` and `skills/readable-code/references/implementation.md`.

## What keel does not do

keel does not bulk-copy rules from an earlier harness, depend on a harness-generating plugin, publish company data, wire live hooks to a development tree, or leave any path where an author writes its own evidence. It also has no plan-gate hook, because one showed no measured effect. The full list is in DESIGN.md §8, and removed or deferred checks are in §10.
