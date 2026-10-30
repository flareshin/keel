# keel — design and build spec

Binding spec for the core build: design v0.6 + ship-gate spec v0.3 + the 2026-10-11 spike results (the spike wins on conflict). Where it is silent, choose the smallest behavior that satisfies it and report the choice as a deviation. MUST / MUST NOT / MAY are normative. All keel files are English. Runtime: Node 24 or newer, built-ins only, running TypeScript directly through type stripping (`erasableSyntaxOnly`, no build step). No Python.

## 1. Purpose and principles

Few principles, each at the strongest feasible layer; every rule enters and leaves through a ledger; verification weight follows risk; public by default, company data private; no re-accretion.

| ID | Charter principle | Strongest layer |
|---|---|---|
| K1 | An author never judges its own output. | hook (ship-gate) |
| K2 | Every done/pass claim carries machine-verifiable evidence. | hook (report-gate) |
| K3 | Changed logic ships with tests in the same diff. | repo CI ▸ hook (ship-gate) |
| K4 | Ask when ambiguous; act when clear. | skill (prompt-refine) |
| K5 | Change only what the request needs, minimally, in code a person can follow. | repo lint ▸ skill (readable-code) |

- Charter rows skip the rule of two (they carry `justification`), never expire, and still need a metric (eval), enforced after `grace_until`.
- readable-code R1–R16 are not ledger rows but K5 sub-checks `[K5.1]`–`[K5.16]`, frozen at 16, outside caps.
- Core experiment `risk`: "Verification weight is proportional to risk." Scope `core`, enforced by ship-gate, `review_by` = end of the two-week post-swap pilot (6.1); charter if the pilot holds.
- Floor (not principles; no rule of two): `F-irreversible` (irreversible actions need explicit user approval; shipping: at merge, 5.4) · `F-secrets` (no secrets or private-lexicon terms in commits, PR bodies, logs or docs the agent writes) · `F-attribution` (no AI attribution in commits or PRs) · `F-force-push` (no force push to shared branches) · `F-hookskip` (an agent never switches hooks off, 5.6) · `F-mod-trust` (every installed Claude Code mod is reviewed: listed in the overlay's reviewed-mods.txt or committed unmodified in the overlay; smoke `mod-trust`, (e)).

## 2. Enforcement ladder

`repo` (lint, architecture tests, CI in the target repo) > `hook` > `skill` > `prose` = the ledger `layer`. A rule enters at the strongest feasible layer; `skill`/`prose` require `why_not_stronger`. Descending to a repo: `layer=repo`, `enforced_at=repo:<owner/repo>:<path>`, keel's own text deleted; metric = existence check (`git show origin/<base>:<path>`) + CI results; zero violations is success, so repo rows never zero-count demote. Public keel keeps the method (core, skills, `descend`); company repo rules live in the overlay ledger.

## 3. Repos and layout

- `~/git/keel` (public goal): core (principles, ledger engine, smoke, ship-gate, review engine, measurement, descend), `stacks/`, `ledger.tsv` (core and stack rows), example data. `~/git/keel-overlay` (private): company and personal data ((a)). `~/.claude` (private): data only (transcripts, memory, logs, state); harness paths in it are symlinks or generated files, gitignored there.
- Links point at a dedicated checkout that moves only by merge; development happens in `~/git/keel-wt/<topic>`. `bin/link --write` MUST refuse when `KEEL_HOME` is a linked worktree (`git rev-parse --git-dir` ≠ `--git-common-dir`) unless `--allow-worktree`. Linked names keep their v1 paths (`skills/<name>`, `commands/`, `agents/`, `workflows/`, `bin/`, `mcp/`).
- `~/.claude/CLAUDE.md` is generated ((h)); no `@import` anywhere (absolute out-of-project imports are silently skipped). keel owns exactly the `hooks`, `permissions`, `env` keys of `~/.claude/settings.json` ((g)).
- Two ledgers (keel, overlay); smoke checks their union; company rows only in the overlay. Stacks now: `spring-maven`; `mysql-ops`, `react-fe`, `review-lenses` come in migration.

## 4. Ledger

Format: (b).
- **Caps** (retired rows excluded): charter ≤ 7 · core ≤ 10 (floor rows excluded) · per stack ≤ 10 · stacks ≤ 5 · overlay ≤ 15 · hook script files ≤ 8 (distinct script paths in the merged settings `hooks`; 5 today) · generated CLAUDE.md ≤ 4608 bytes (`bin/link`) · each `projects/*/memory/MEMORY.md` ≤ 8192 bytes (per project, apart from CLAUDE.md; WARN) · smoke assertions ≤ 2 × active ledger rows + 40 (one assertion = one check kind × one scope, never per path).
- **Rule of two:** rows neither `scope=charter` nor `type=floor` need ≥ 2 distinct incident refs: `docs/incidents/<name>.md` (must exist in keel) or `private:<id>` (overlay ledger only). Failing rows are GRACE, not FAIL, while `grace_until` ≥ today. When a keel row fails or is in grace, memory files `feedback_*` are listed as incident candidates, never FAIL.
- **Metric:** every active row has one (`measure/run`, (e)); zero recognized items = FAIL, GRACE while today ≤ `grace_until`.
- **Expiry (proposals only):** non-charter, non-floor rows carry `review_by` (default creation + 60 days; charter and floor `-`). `measure/propose` (weekly overlay scheduled task) over rows past `review_by`: count 0 → propose demotion (`hook`→`skill`→`prose`→`status=retired`); count > 0 → `review_by` + 60 days; repo rows: failing existence check → re-check, zero violations never demotes. A metric whose runner errored (crash, non-zero exit, no JSON) is never count 0 and never yields a demote/retire proposal; it is a `recheck` with the error as reason. `--model-upgrade <model>`: one re-review proposal per active row (an A/B diff is a separate user-approved step). Output: stdout only. Nothing edits a ledger; the user applies an approved proposal by editing the row. `status=proposed-demote` = accepted for demotion at the next edit; still counted in caps. `type` is classification only, never a demotion axis.
- Every outside rule (plugin distillation, sync jobs) enters only through a ledger row.
- **[ID] tagging:** in every rule location each bullet line (`^\s*(?:[-*+]|\d+\.)\s+`) MUST continue with `[<ID>]`, an active ledger id or `K5.<1-16>`. Rule locations: `PRINCIPLES.md`, overlay `PERSONAL.md`, the rules section of every `SKILL.md` (any `## Rules` heading variant, with qualifier or trailing colon, to the next `## `), every hook deny/warn message (checked by each hook's tests, and at runtime by smoke: every fires `rule_id` exists in a ledger).

## 5. Ship-gate

Gates branch `git push` and `gh pr merge`; both need review and tests evidence, approval only at merge (5.4). Question: is every outgoing path, with the same content and mode, in the diff ONE evidence bundle (review chain + tests + approval) reviewed? Enforces K1, K3, risk. A person pushing from their own terminal is the deliberate escape hatch.

### 5.1 Comparison model
- **C (outgoing):** `git diff --raw -z --no-renames <mb> <head>`, `mb = git merge-base <base> <head>`: `(path, new_blob | deleted, new_mode)`; a rename = delete + add.
- **E (reviewed):** `(path, blob | deleted, mode)` of the diff a review saw: working tree `review_base` → snapshot tree; commit range (`head:<sha>`, promote) `review_base` → `<sha>`, checked-out tree irrelevant; delta `since` tree → reviewed tree.
- **Chain:** one root review (`since` null, `root_run_id = run_id`) plus deltas, each pointing at the previous review evidence of the same repo and root, with a new `run_id` and inherited `root_run_id`. A multi-repo run writes one evidence per repo, same `run_id`. E = fold root → head, later wins per path. Head = review evidence with no successor.
- **Verdict per repo** (one chain covers all of C, else an approved series below; unrelated evidence never combines):
  1. Head verdict `PASS` (earlier links MAY be `NEEDS_FIXES`; a later delta must resolve their findings).
  2. Base scope: the root's `review_base` equals or is an ancestor of `mb` (`git merge-base --is-ancestor`); a narrow base (`HEAD~1`) fails.
  3. Every non-gitlink C entry is in E with the same blob and mode, or its blob is a comment-only deletion (5.4) of the reviewed blob; a deletion needs `(path, deleted)` in E; a missing path fails.
  4. Review kind, tests, smoke, approval per 5.4.
  5. Provenance: every chain review has `source.agent_id`. A reviewer whose transcript shows Edit, Write, NotebookEdit, MultiEdit, or a Bash write outside a temp dir (`/tmp`, `/private/tmp`, `/var/folders`, `$TMPDIR`) is an author: no review evidence, K1 warn with detail starting `reviewer-mutated`.
- **Approved series:** when no one chain covers C, the range from `mb` to head splits into intervals, each judged by rules 1–5 against one chain with an approval bound to its head (push included): consecutive chains (the interval is the chain's `review_base` → a commit whose tree it reviewed), or chains reviewed in parallel and stacked by rebase (the interval is a run of first-parent commits, from the run's first parent to its last commit, and the root's `review_base` equals or is an ancestor of `mb`). Every interval must be covered; tests still cover the head's content (5.4). Two stacked chains that changed one path fail: the stacked blob is in neither review. The deny names that path, its reviewing chains and the last commit that changed it; a review of that commit from its parent, approved, joins the series as a consecutive interval.
- Passes: conflict-free rebase, branch rename, one change over several pushes, a comment-only deletion after review (5.4). Fails: any other content, mode or path change after review (incl. rename); reverting to an older non-base value, unless that value is a comment-only deletion of the reviewed blob (5.4).
- Gitlinks (mode 160000) skip blob matching (5.5).

### 5.2 Block points and range

| Command | Action | head / base |
|---|---|---|
| `git push [remote] [src[:dst]…]` (branches) | gate | head = each refspec's `src` (none: HEAD); remote = the first positional word, else `--repo`, else the branch's push remote (5.3); honors `-C` (`~`, `$VAR`, `${VAR}` spelled out), `cd X &&`, chains (`&&`, `;`, `\|\|`, newlines); ignores heredoc data. base = `origin/<integration_base>` (missing → fail closed, 5.7) |
| `git push --delete`, `:dst`, `--tags`, `--dry-run`/`-n`, refspec `src` a tag with `dst` absent or under `refs/tags/` | pass | — |
| `git push <remote> <tag>:<branch>` (or `refs/tags/x:refs/heads/y`) | gate as a branch push | head = the tag's commit |
| `git push --all`/`--branches`/`--mirror` in a gated repo | deny | — |
| `gh pr merge` (`-R`/`--repo` before `pr`, between `pr` and `merge`, or after) | gate; deny without `--match-head-commit <sha>`; merge-preflight: no failing check (without `--auto` none pending) | head = sha, base = `origin/<baseRefName>` |
| `gh pr create` | warn: early warning (what the branch lacks) | current branch |

- One shell parser, `hooks/lib/hookkit/shell.ts` (the one parser; the other `hookkit` modules are helpers such as `fields`, `text`, `paths`, `files`, `json`, `jsonout`, `errors`), serves ship-gate, git-guard, report-gate, env-preflight. ship-gate and git-guard share its push-argument reader, its `gh` subcommand reader, its `git config` reader (read or write, and the key named) and its path resolver (`-C`/`cd` directories and the files a command writes or reads: `~`, `$VAR`, `${VAR}` from the call's shell variables (plain and exported; a value is expanded when assigned, from the call's own variables and `$PWD` only) over the hook's own environment, `$PWD` as the step's directory). It follows wrappers (`env`, `timeout`, `nice`, `exec`, `sudo`), `-C`, `cd`, chains, `bash -c`/`eval` strings, `$(…)`, heredoc bodies, and reads git's dashed programs at a literal path (`/usr/libexec/git-core/git-push …`) as `git <subcommand>`, so git-guard's checks see them too. It reads past a wrapper option it does not know as a flag and records it as unattributable, as it does sudo's directory-moving `-D`, `--chdir`, `-R` and `-i`, so git-guard still sees the command (`sudo -i git push --force …`). A push or merge it cannot attribute to one repo and branch is denied `[K1]` in any repo (fail closed), ending with the exact command for the user's terminal (the whole call when a name is resolved at run time): a forwarder the parser keeps (`xargs`, `parallel`) or a wrapper carrying an unattributable option (`env --chdir=…`, `sudo -i`) whose wrapped words name `git`, `gh` or a shell (a dashed `git-push` too) or something resolved at run time, in a call that spells a push or merge anywhere (other programs, e.g. `echo`, `rm`, `grep`, and a `command -v` lookup pass), `gh api` that writes to an endpoint or GraphQL query resolved at run time (the query's text, a field named at run time: `-f "$KV"`, or a word that may expand to options: `gh api graphql $F`), `gh api` that merges or moves a branch (`…/pulls/<n>/merge`, `…/merges`, a non-GET call to `…/git/refs…`, a GraphQL `mergePullRequest`, `mergeBranch`, `enablePullRequestAutoMerge`, `createRef`, `updateRef(s)` or `deleteRef`), git plumbing that pushes without `git push` (`send-pack`, `http-push`, `subtree push`), a subcommand resolved at run time (`git $S`), a program resolved at run time (`$GIT`, `$CORE/git-push`, `"$(…)"/…`) in a call that spells a push or merge anywhere (its own path, an assignment, a loop list, another command's argument; `merge-base` counts, no exemption) or whose arguments make a `gh api` write, a push remote resolved at run time (`git push $R`, `"$R"`, `${R:-x}`, `$(…)`), a push target that is no remote of the clone, URL or existing path, `gh pr merge` naming no repo in a clone whose remotes name several repos with one gated (the user-run line adds `--repo <that repo>`), git aimed at another repository (`--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`), a push whose routing config the clone does not hold when the gate reads it (`-c`/`--config-env` on a `remote`, `branch`, `url`, `push` or `include[If]` key, any `GIT_CONFIG*` variable, or, anywhere in the call, a `git config` write of such a key (option values such as `--file`/`--type` skipped; a write naming no key, e.g. `--edit`, counts; reads never count: `get`/`list`, a read option, or one name with no write option) or `git remote set-url|add|rename`; the user-run line is the whole call). `tests/fixtures/push-merge-spellings.tsv` (`command`, `expect` = `gate` \| `pass` \| `deny`) lists every tested spelling.
- Merging the integration branch moves `mb`: colleagues' files leave C, only files changed on both sides need re-review. Empty C → pass.

### 5.3 Gated-repos registry
`$KEEL_OVERLAY_DIR/gated-repos.tsv` ((h)): `origin gate integration_base risk_rules tests [push_approval [auto_merge]]`.
- `push_approval` `true` \| `false` (default; five columns = `false` everywhere): `true` where a branch push deploys or notifies; its pushes need approval like a merge.
- `auto_merge` `true` \| `false` (default; absent = `false`): `true` where review and tests are the whole merge bar. Every approval check passes without an approval record: `gh pr merge`, a `push_approval=true` push and the live fast-forward. Review and tests still apply. The optional columns come in order; a file may stop after any of them.
- `gate=code`: full model. `gate=smoke`: every push needs smoke evidence covering C, no review. `gate=off` or unlisted: pass.
- Repo key = `owner/repo` (lowercase, last two path segments, `.git` stripped, host ignored) of the repo the command changes. A push reaches every push URL of its remote (`git remote get-url --push --all`; 5.2), or its remote argument as a URL or a path from the clone's top level. Of several repos, a gated repo other than the clone's origin is judged first (deny `F-irreversible`: push from its own clone), then the clone's own gated repo, else the first. A remote resolved at run time, or one that is no remote, URL or existing path, is denied as unattributable. `gh pr merge`: `--repo`/`-R`, else `GH_REPO`, else the PR URL, else gh's default (`remote.<name>.gh-resolved`: the `owner/repo` it stores, or with `base` that remote's URL), else the clone's single remote repo (a stored value that names no `owner/repo` fails closed; a merge naming no repo is unattributable when the same call also runs `gh repo set-default <repo>` or a remote config change); several remote repos with one gated → deny unattributable with the `--repo` command to run. Other commands: origin. A repo's worktrees share evidence. No registry → all repos off (`outcome=warn` once per session).
- Intended: company code repos `code`; keel `code` (docs, settings `light`); keel-overlay `code` with settings fragments, data and prompt paths (`scheduled-tasks/`, `mcp/`, ledger, registry) `smoke-only` and code (`mods/`, `bin/`, `skills/*/scripts`) `standard`; the `~/.claude` data repo and personal repos `off`.
- A job touching only smoke-only paths runs `measure/smoke --candidate` from the worktree (`KEEL_OVERLAY_DIR` or `KEEL_HOME` = the worktree), `keel evidence write-smoke --repo <worktree>`, then pushes; after the merge the owner runs `bin/link --write` so the live data dir follows.

### 5.4 Risk classes
The gate recomputes risk from C; evidence never states it. Ambiguous → heavier.

| Class | Paths | Required |
|---|---|---|
| smoke-only | every C path matches a `smoke-only` rule | smoke evidence covering C |
| light | `light` rules (FE copy/style, docs, config) | `lens-review` chain + tests if registry `tests=required`; approval at merge |
| standard (default) | no rule matches | `lens-review` chain + tests; approval at merge |
| heavy | `heavy` rules (settlement, pricing, inventory writes, schema, batch, external contracts) | `lens-review` chain + tests; approval at merge |

- "At merge" = `gh pr merge`, plus `git push` where `push_approval=true`; no approval where `auto_merge=true`. Review and tests apply at both push and merge. Every chain link MUST be `lens-review` (a `single-lens` link → `[risk]` deny).
- Per path: a test path (segment `test`, `tests`, `__tests__`, or basename `test_*.py`, `*_test.*`, `*.test.*`, `*.spec.*`) adds nothing (alone: light); else the repo set's heaviest matching rule; else standard. Push class = heaviest path. smoke-only only if every path is; otherwise smoke-only paths count as light.
- Registry `tests=none`: light passes without tests; standard and heavy deny "[K3] add test infrastructure first".
- K3: a logic path is a C path that is no test path or gitlink and classifies standard or heavy. Logic path with no test path → deny `[K3] logic changed with no test in the same range`, unless the chain head's `KEEL-EVIDENCE` ((d)) has `no_test_reason`, recorded on the pass line. A path whose change from its merge-base blob is a comment-only deletion is no logic path for this check. No logic path → no check.
- Comment-only deletion (`lib/evidence/comment_cleanup.ts`) of an old blob (merge-base, reviewed or evidenced) into a new one: same mode (`100644` or `100755`); a `.js`, `.ts` or `.java` file of at most 1 MiB (a `.py` file is none: Python is not run to prove it, so any `.py` change needs fresh evidence) that shrinks to a non-empty file; every comment of the old file, kept or removed, is non-empty (a bare `//` line makes the file no comment-only deletion), holds only letters, digits, `_`, whitespace and `.,!?()'"-` and none of the `PROTECTED` words anywhere, case-insensitive (notice and licence words, tool and linter directives, and words such as `ignore`, `command`, `global`, `region`, `generated`, `__`), so `// ignore empty rows` or `// note: x` makes the file no comment-only deletion; only comments on lines of their own are removed. A file the scanner cannot judge is none either; the exact list is `onlyCommentDeletions` and `slashComments`, and examples are text that is not UTF-8, a backtick in `.js`, `.ts` or `.java`, and in `.js` or `.ts` a `/` or `<` outside strings and comments (division, regex, generics, JSX).
- Tests and smoke evidence cover C when each C path has the same blob and mode in `git ls-tree <evidence.tree> -- <path>` (deleted = absent), or its blob is a comment-only deletion of that blob.
- Tests evidence also covers C when every C path is a non-deleted gitlink and, for each, the submodule's tests evidence (repo key from the `.gitmodules` url at the pushed head) has `head` equal to the pointer and `tree` equal to that commit's tree. A C that also changes a parent file still needs parent tests evidence covering all of C.
- Approval matches when `root_run_id` equals the chain's and `heads[<repo key>]` equals the chain head's `evidence_id`; a later delta moves the head and needs a new approval. One approval covers every repo of its root (submodule first, then parent; cross-repo), never another root.

### 5.5 Submodules
- A review over a parent with submodules writes one evidence per repo (one `KEEL-EVIDENCE` line per `diffs[]` item); blobs are per submodule, the parent sees gitlinks.
- "No commits in a parent repo" rules are overlay git-guard data.

### 5.6 Who writes evidence

| Kind | Writer | Provenance |
|---|---|---|
| review | report-gate at `PreToolUse[SubagentHandback]` (or `SubagentStop` without a hand-back that turn), when, after one leading `<<<KEEL-REPORT` line and one trailing `KEEL-REPORT>>>` line are dropped where present (trailing whitespace per line ignored, blank lines at either end dropped first, a marker line matched with its own whitespace trimmed), the report's line 1 is `VERDICT: PASS` or `VERDICT: NEEDS_FIXES` with ≥ 1 `KEEL-EVIDENCE:` line, each piped to `keel evidence write-review` | payload `agent_id`; `source.agent_transcript_path` as report-gate derives it ((g)). `write-review` refuses (3) without `agent_id` or when that file does not exist; it recomputes (blob, mode) from git object ids, never trusting a path list from the message |
| tests | `keel test -- <cmd>` | its `keel-tests.jsonl` line; 0 tests → none |
| smoke | `keel evidence write-smoke` after `measure/smoke` | its `keel-smoke.jsonl` line and tree |
| approval / ack | `keel approve <root_run_id> [--read]` in the user's terminal only; no gate reads ack | heads pinned at write |

- Reviewers never run a write command; lens-review ends with a reporter agent (plain text, no StructuredOutput) whose last message is the (d) report; a message that, after one leading `<<<KEEL-REPORT` line and one trailing `KEEL-REPORT>>>` line are dropped where present (trailing whitespace per line ignored, blank lines at either end dropped first, a marker line matched with its own whitespace trimmed), differs from the expected report on any line gets one more reporter dispatch naming the problem, and a second such message makes the run ERROR. Before that comparison the workflow drops a leading `[harness: …]` notice line and the blank line after it: Claude Code prepends it to the copy the workflow receives (not to the hand-back report-gate reads) when a report quotes instruction-shaped text such as `permissions.allow`.
- git-guard denies Edit/Write/NotebookEdit on `$KEEL_DATA_DIR/state/keel/**` and `$KEEL_DATA_DIR/logs/keel-fires.jsonl`; Bash writing or removing one of those (target resolved like a `cd` target: `~`, `$VAR`, `${VAR}` from the call's shell variables (plain and exported; a value is expanded when assigned, from the call's own variables and `$PWD` only) over the hook's own environment, `$PWD` as the step's directory, relative to the step's directory); Bash running `keel approve` or `keel evidence write-review`.
- `[F-hookskip]` git-guard denies: `claude … --settings '<inline JSON>'` with `disableAllHooks` unless that call disallows Bash, Edit and Write; an Edit/Write, or a Bash write whose call text spells it, setting `disableAllHooks` in `.claude/settings*.json`; `git commit|merge|push --no-verify`, `git commit -n`, `git -c core.hooksPath=…`, a `git config` write of `core.hooksPath` (reads pass); writes to `logs/keel-fires.jsonl`.
- `[C-isolation]` git-guard denies Edit/Write/NotebookEdit, plain Bash writes and git subcommands moving index, HEAD, a branch or the working tree (checkout, switch, restore, reset, add, rm, mv, commit, cherry-pick, revert, am, apply, merge, rebase, pull, stash, clean) under the live checkouts (realpath of `KEEL_HOME`, `KEEL_OVERLAY_DIR`), not their worktrees; git is judged in its `-C`/cwd directory; a write after a `cd` the hook cannot resolve is judged where the call starts and the message says so; a write target whose own variables stay unresolved passes; the message prints `git worktree add` and the user-run `git merge --ff-only`.
- F-attribution also scans every heredoc of the Bash call, files given to `gh pr create|edit|merge --body-file`, `gh pr merge --subject/--body`, and the pushed commits (`<source> --not --remotes`; `--all`/`--branches`/`--mirror`: `--branches --not --remotes`). F-secrets also scans Write/Edit/NotebookEdit content and staged commit content for known values from overlay `git-guard/known-values.tsv` ((h)), built at runtime: values of 6+ characters, never logged or printed; a hit names `file:line` and the key.
- A missing expected payload field → `outcome=contract-miss` (detail: missing fields, keys received, `cc_version`), behavior unchanged. report-gate expects `tool_input.message`, `agent_id`, the derived transcript (hand-back); `agent_id`, `agent_transcript_path`, and `last_assistant_message` unless the transcript holds final text, the report was handed back or the agent used `StructuredOutput` (SubagentStop). ship-gate: `tool_input.command` (Bash).

### 5.7 Failure mode
- ship-gate error on a push or merge in a `gate=code` or `gate=smoke` repo, or before its repo is known while any registry row is gated → deny; otherwise pass. A crash while the call may push or merge (a push or merge word anywhere, a push or merge spelled without one (`send-pack`, a REST `merges` or `git/refs` endpoint, a GraphQL merge or ref mutation), or `git`/`gh` beside a name resolved at run time, so `gh api …/pulls/N/merge` and `S=push; git $S` count) → deny. A crashed or timed-out process: `onFailure:"block"` ((g)).
- Every deny or warn names its rule as `[ID]` ((g)). A deny ends with the next step: `Run it yourself in your terminal: <command>`, or where no command fits (protected-file edit, report to redo, a line no rewrite fixes) `Stop and ask the user.` or report-gate's hand-back instruction. A warn refuses nothing, no last line. One test covers all hook messages.
- Every decision is a `keel-fires.jsonl` line.

### 5.7a Threat model
- Hooks stop an honest agent's mistakes and shortcuts written as commands normally are; an unattributable spelling is denied, not guessed (5.2).
- Deliberate evasion is out of scope: a parser over arbitrary shell cannot be complete. Accepted gaps: every spelling §10 removed; a program name or script built so the call spells no push or merge (`$(echo … | base64 -d)`, `bash p.sh`, a symlink); a main thread briefing a rubber-stamp reviewer (the gate cannot tell who authored a diff).
- Final guard: branch protection on integration branches (required PR, review, status checks) binds every author; a gated repo without it has a gap in that repo, not in keel.

### 5.8 Hook integration
ship-gate and git-guard are one script each: registrations (g), decisions (f).

### 5.9 Fixture scenarios (ship-gate track, `tests/ship-gate/`)
Temp bare origins at `<tmp>/remotes/<owner>/<repo>.git` (key `owner/repo`), clones, temp `KEEL_DATA_DIR` and overlay. Tests run the hook on a synthetic payload and assert exit code and fires line; real pushes only when a remote ref is needed (submodule).

| # | Scenario | Expected |
|---|---|---|
| 1 | lens-review PASS + tests, then approval | push passes without approval; no tests → `[K3]`; `gh pr merge` without approval → `[K1]`, with → pass; `push_approval=true`: push without approval → `[K1]` |
| 2 | one run reviews submodule A and parent B; one approval | push A, B: pass; merge A, B: pass on it |
| 3 | root R covers A, B; A changes; delta PASS on A; one approval | merge A, B: pass on it |
| 4 | NEEDS_FIXES → fix → delta PASS → approval | pass |
| 5 | approval, then a new delta PASS in the root | merge denied (head moved); new approval → pass |
| 6 | conflict-free rebase after review | pass |
| 7 | edit after review | deny, names the path |
| 8 | `review_base = HEAD~1` over two commits | deny (base scope) |
| 9 | reviewed change reverted to an older non-base value | deny |
| 10 | deletion reviewed / not | pass / deny |
| 11 | chmod +x after review | deny |
| 12 | binary file no rule names | standard, like any path |
| 13 | rename after review | deny |
| 14 | (removed, §10) | — |
| 15 | integration branch merged after review: disjoint / overlapping file | pass / deny |
| 16 | (removed, §10) | — |
| 17 | promote: `gh pr merge --match-head-commit <sha>`, review `head:<sha>` | with approval pass; no flag → deny (gh stub `KEEL_GH`) |
| 18 | approval of root R1, change reviewed under R2 | merge (or `push_approval=true` push) denied; plain branch push passes |
| 19 | `write-review` without `agent_id`, or naming a missing agent transcript | exit 3, no evidence; git-guard denies the CLI call |
| 20 | smoke-only push (overlay data) with / without smoke evidence; mixed with a code path; from an overlay worktree after `measure/smoke --candidate` | pass / deny / needs review / pass |
| 21 | K3: logic only / + test / + `no_test_reason` / docs only | deny `[K3]` / base class / pass, reason recorded / not evaluated |
| 22 | each `push-merge-spellings.tsv` row (5.2) | its `expect` |

Also: `gate=code` internal error → deny; `gate=off` → pass; every risk pass/deny line has `files` and `lines`.

## 6. Measurement

- `measure/weekly`: repo-layer rules; always-loaded bytes (generated CLAUDE.md; sum of MEMORY.md indexes, apart); post-deploy defects; keel core non-test lines of code and `docs/DESIGN.md` bytes (no cap; unexplained growth is an incident).
- Defect sources (overlay metric runners): hotfix branches and direct production commits, tickets triaged as code bugs, reverts; each tied to the original ship's risk class via ship-gate's `pass` fires line (`risk`, `head`, `root_run_id`).
- Secondary: context per turn, share of turns over 200k, review time per risk class, demotion proposals. The v1 lens-recall eval is re-baselined after repair in migration (v1 doctrine negatives are retired: every case is hook-enforced).

### 6.1 Risk pilot exit criteria (pre-registered)
The two-week post-swap pilot decides `risk`. The user confirms or changes these numbers before the first piloted ship; the commit setting them predates the first fires line with a `risk` value. `run:risk` reports every input.
- Inputs per class: ships (`pass` lines), escaped defects traced to the ship's class (§6), rework (lines shipped and changed again within 14 days, from git, refactor-only commits excluded), median chain-head PASS → approval time. Baseline: the previous harness's last 60–90 days in the same repos, re-classified by the same function, labelled historical.
- **extend** (never keep): < 8 light or < 5 standard ships; two more weeks.
- **keep** (`risk` → charter): 0 escaped light defects; light rework ≤ standard + 5 percentage points; light median review-to-approval below standard's.
- **adjust**: exactly 1 escaped light defect, or light rework over the bound with 0 escaped; move the path rules behind the misses one class heavier, two more weeks.
- **drop** (retire `risk`, all pushes standard): ≥ 2 escaped light defects, or light review-to-approval not below standard's.
- Each later relaxation of a class is its own user-approved ledger change.

## 7. Migration and swap

1. Core build (this spec): two ledgers, smoke, `bin/link --check`, six hooks with tests, ship-gate, review-engine evidence, skills, this document.
2. Port stacks and overlay: every v1 item passes a ledger review or stays only in tag `v1-final`. Overlay fragments MUST re-declare every existing deny/ask permission rule. v1 `REVIEWED_MODS` ids move to overlay `reviewed-mods.txt` (smoke `mod-trust`). ship1 follows ship-gate evidence; the HUD becomes display-only (reads evidence files). Repair the v1 lens-recall eval.
3. Review in a separate context (lens-review).
4. CLI rehearsal: smoke, dangling-link gate, one real work item through ship-gate, rollback.
5. Swap (user approval): tag `v1-final` → `bin/link --write --adopt --force --accept-drops <file>` (`--force` because the v1 CLAUDE.md is in the way; it moves to the link-backup dir) → desktop checklist; on failure `bin/link --unlink`.
6. After: two-week risk pilot; descend the most frequent review lens into a repo rule, one or two per month.
7. Before public: boundary check over all history (rewrite or fresh repo if needed) + a separate reviewer asking only "does anything company-specific remain?" → public (user approval).

v1 runs until the swap; the dangling-link check gates it.

## 8. What keel does not do

Bulk-copy v1 rules; adopt a harness-generating plugin; delete the v1 repo; generate all of settings.json; keep a hashed lexicon; publish company data; make the owner's use depend on a plugin load path; wire live hooks to a development tree; leave any path where an author writes its own evidence; admit a plan-gate hook (deny code edits until a `Plan:` line): it showed no measured effect, and K4's approved brief covers the spec.

## 9. Compatibility

Relied-on Claude Code behaviors; a change is contract drift, logged by report-gate and ship-gate as `outcome=contract-miss` with `cc_version`:
- Payload fields as in (g); `agent_id` only inside a subagent; `SubagentHandback` carrying the full subagent report in auto mode.
- `"onFailure":"block"` (Claude Code 2.1.295, 2.1.296): a crash or timeout blocks the call; Stop, SubagentStop, TaskCompleted, TeammateIdle ignore it.
- A missing registered script makes `node` exit 1, which does not block: the fail-open hooks (report-gate, model-assign, env-preflight) fail open, and ship-gate and git-guard still block through `"onFailure":"block"`; `link --check` and smoke `dangling` catch it.

## 10. Removed and deferred (2026-10-11 audit)

Removed: no incident backed them (5.7a). Re-admission, `D` (deferred) first: a ledger row citing 2 real incidents and a metric counting them (§4). report-gate, model-assign, handoff, env-preflight, `bin/link`: nothing removed.
- `ship-gate-N`: 10 git alias deny; 9 unattributable deny for non-forwarders; 3 quote-insensitive prefilter; 5 tag/branch name-collision check; 7 own refspec-not-a-commit deny; 20 D `keelBase` recording and base; 21 D stale-base warning; 15 deny on disagreeing `--repo`/`GH_REPO`/PR URL; 16 client-side `headRefOid` check; 17 preflight PR not OPEN, draft, CONFLICTING; 26 light `single-lens` review; 27 binary → heavy; 28 test lines deleted, test deleted/renamed → heavy; 29 D heavy size cap; 30 heavy read ack; 31 `gate=smoke` error passes; 36 pushing agent wrote a link; 37 write-review transcript path checks; 40 `no_test_reason` cap, head-PASS re-check; 41 unpushed-submodule deny; 44 D prompt-sentence approval/ack; 45 `/ship` prompt and Skill early warning; 51 contract-miss for `cwd`, `prompt`, `tool_input.skill`; 46 BaseException catch, non-object `tool_input`; 49 fires-unwritable fallback; 52 evidence id-collision refusal; 53 gc of merged heads.
- `git-guard+lib-N`: 17 HUSKY/LEFTHOOK/SKIP; 21 inline interpreter settings writes; 22 cp/mv/install/ln/rsync of a prepared settings file; 18 `--settings` by file or `<(…)`; 23 `$KEEL_DATA_DIR/settings.json` protection; 24 ancestor removals, `projects/**/*.jsonl` protection, `$KEEL_DATA_DIR` expansion; 25 unresolved and inline store writes; 27 `keelBase` config deny; 29 C-isolation for branch, update-ref, symbolic-ref, `patch`, inline writes; 30 following `--git-dir`/`--work-tree`/`GIT_DIR`/`GIT_WORK_TREE`; 7 PR text from other commands, assignments, env; 5 `-F -`, `/dev/stdin` heredoc resolution; 8 upstream and base push-range tiers; 11 rm/mv, `-i`, `--pathspec-from-file` as staging; 13 known values in pushed commits; 2 fail-closed on keel-only payloads; 3 global 8 s deadline, process-group kill.
- `measure-N`: 8 smoke CLAUDE.md cap; 9 MEMORY.md GRACE→FAIL; 12 FAIL on malformed fires lines; 14 `feedback_*` note on passing runs; 17 runner-name check; 21 PROPOSAL lines in expiry WARN; 22 `proposals.json`; 25 weekly `metrics`, `expiring`; 26 weekly `core_size` error object; 34 pre-commit per-exit messages; 36 CI WARN for a missing lexicon; 39 memory-imperatives; 2 single-segment origin trees.

Kept after review (cuts not applied):
- Classifier block, owner kept: ship-gate 11 `gh api …/merge` deny, 12 run-time command name; report-gate (`other-hooks-N`) 6–9; model-assign 13; handoff 20, 23; env-preflight 29, 31, 33–35; lib 34, 35, 37; link 2, 11, 13, 16, 19, 22.
- Hard limit (floor, (c)–(h) contract): ship-gate 24, 30, 40, 42, 52, 56; measure 24, 28, 42; link 10.
- Pinned outside the track: ship-gate 2, 31, 46; lib 36, 39, 42; measure 44.
- Earned core only: lib 4, 20; measure 38.

## Interfaces

### (a) Directory layout and file ownership

A track writes only its own paths and `examples/<track>/` (overlay-shaped, invented values). Cross-track contracts are the CLIs and formats here, never cross-track imports (except the shared shell parser, 5.2); a track MAY duplicate a few lines (data-dir resolution, a fires append).

| Track | Paths |
|---|---|
| ledger-smoke | `ledger.tsv`; `measure/` (run, smoke, propose, boundary, weekly; `lib/measurekit/`, `metrics/<id>`, `boundary-generic.tsv`; `evals/` = `eval`, `review-eval`, `lib/evalkit/`, `<id>/{train,holdout}.tsv`, `<id>/repo/`, `review/cases/<case>/`); `githooks/` (pre-commit, pre-push); `tests/measure/` (stub `claude` in `stubs/`) |
| link | `bin/link`, `lib/link/`; `tests/link/` |
| ship-gate | `bin/keel`, `lib/evidence/`, `hooks/ship-gate/ship-gate.ts`; `tests/ship-gate/` |
| hooks | `hooks/<name>/<name>.ts` (report-gate, git-guard, model-assign, handoff); `hooks/lib/hookkit/`; `stacks/spring-maven/` (`hooks/env-preflight.ts`, `settings.json`); `tests/hooks/` |
| skills | `PRINCIPLES.md`; `skills/` (`prompt-refine/` K4, `readable-code/` K5 with `scripts/rule-checks.ts`, `descend/`, `improve/`); `tests/skills/` |
| review-engine | `workflows/` (`lens-review.js`, `adversarial-audit.js`, `review-lenses.json`); `agents/` (`keel-auditor.md` for audit and verify agents, `keel-reporter.md` for the reporter: tool-limited subagent types passed as `agentType`); `tests/workflows/` |
| integration | `settings/` (`core.json`, `links.tsv`), `README.md`, `docs/incidents/`, `tests/run-all.sh` |
| spec | `docs/DESIGN.md` |

- Another track's executable runs by absolute path — its (i) variable if set, else that variable's default — directly (argv[0] = the path; 0755 with a shebang), never via `PATH`, `~/.claude/bin/…` or a shell string.
- review-engine agent prompts name the data-dir copies as shell text: `"${KEEL_DATA_DIR:-$HOME/.claude}/bin/keel" snapshot <repo>`, `node "${KEEL_DATA_DIR:-$HOME/.claude}/skills/readable-code/scripts/rule-checks.ts" …`; so the link manifest ((h)) MUST link `bin/keel` and `skills/readable-code`.
- Tests stub a dependency not under test via its (i) variable (`KEEL_GH`, `KEEL_CLI`, `KEEL_BOUNDARY`, `KEEL_LINK`, `KEEL_CLAUDE`): a stub records argv and prints its (e) stdout/exit code.
- Executables: a `#!/bin/bash` shim, 0755, no extension under `bin/`, `measure/` and `codex/bin/`. The shim follows its own symlinks to the real file and `exec`s `node` on the `.ts` entry beside it, passing arguments, stdin, stdout, stderr and the exit code through. Entries resolve `KEEL_HOME` from their own real location unless it is set.
- Tracks PROPOSE ledger rows, settings entries and link lines in their report (TSV / JSON); ledger-smoke seeds (b); integration writes `settings/` from (g).

Overlay (`$KEEL_OVERLAY_DIR`): `PERSONAL.md`, `ledger.tsv`, `gated-repos.tsv`, `risk-rules.tsv`, `stacks.txt` (one active stack per line), `reviewed-mods.txt` (one reviewed mod id per line, smoke `mod-trust`), `links.tsv`, `settings/*.json`, `boundary/lexicon.txt`, `boundary/regex.txt`, `git-guard/repo-rules.tsv`, `git-guard/known-values.tsv`, `stack-data/spring-maven/jdk.tsv`, `measure/metrics/<id>`, `tests/hooks/fixtures/<row id>.bad.json` (overlay hook rows) and `tests/hooks/fixtures/<hook>.good.json` (hooks whose script lives in the overlay), smoke `wired-fires`. All optional; missing = no data (but smoke FAILs without `boundary/lexicon.txt`).

TSV: UTF-8, LF, tab-separated; blank and `#` lines ignored; the first other line is the header and MUST match exactly; empty value `-`; no tabs in values.

### (b) ledger.tsv

Header (exact):
```
id	scope	type	statement	layer	enforced_at	why_not_stronger	justification	incidents	metric	review_by	grace_until	status
```

| Column | Values |
|---|---|
| id | `^(K[1-7]\|risk\|[CSOF]-[a-z0-9-]+)$`, unique across both ledgers. K=charter, C=core, S=stack, O=overlay, F=floor |
| scope | `charter` \| `core` \| `stack:<name>` \| `overlay` (overlay ledger holds only `overlay`) |
| type | `knowledge` \| `incentive` \| `floor` |
| statement | one sentence |
| layer | `repo` \| `hook` \| `skill` \| `prose` |
| enforced_at | `hook:<name>` \| `skill:<name>` \| `prose:<file>` \| `repo:<owner/repo>:<path>` |
| why_not_stronger | required (not `-`) for layer `skill` or `prose` |
| justification | required for charter and floor rows |
| incidents | comma-separated `docs/incidents/<name>.md` or `private:<id>`; ≥ 2 for non-charter non-floor rows |
| metric | `fires:<rule_id>` \| `evals:<eval_id>` \| `run:<runner>` \| `exists:<local repo path>:<ref>:<path>` |
| review_by, grace_until | `YYYY-MM-DD` or `-` |
| status | `active` \| `proposed-demote` \| `retired` |

Seed rows, all `grace_until` 2026-12-10, `layer` = the `enforced_at` kind, metric `fires:<id>` (K4, K5: `evals:<id>`), `review_by` `-` for charter and floor else 2026-12-10, incidents `-`: K1, K2 (charter, incentive; `hook:ship-gate`, `hook:report-gate`) · K3 (charter, knowledge, `hook:ship-gate`) · K4, K5 (charter, knowledge; `skill:prompt-refine`, `skill:readable-code`) · risk (core, knowledge, `hook:ship-gate`) · F-irreversible (core, floor, `hook:ship-gate`) · F-secrets, F-attribution, F-force-push, F-hookskip (core, floor, `hook:git-guard`) · F-mod-trust (core, floor, `prose:docs/DESIGN.md`, metric `exists:~/git/keel:HEAD:measure/lib/measurekit/smoke_mods.ts`: no layer names a smoke check, and a mod acts before every hook) · C-dispatch (core, incentive, `hook:model-assign`) · C-handoff (core, knowledge, `hook:handoff`) · C-isolation (core, incentive, `hook:git-guard`) · S-jdk (`stack:spring-maven`, knowledge, `hook:env-preflight`).

Incident refs added later (2026-10-30), two `docs/incidents/` files each: C-dispatch, C-isolation, S-jdk, C-precheck, C-comments. A hook deny counts as an incident when its file names the cost the deny prevented, as the overlay already does with guard denies.

Retired 2026-10-30, with no incident to cite: C-review-command (its approval-explanation duty is K5's "Explain approval requests per `docs/review-policy.md`"), C-verbatim-fix (the rule stays as untagged prose in `docs/review-policy.md`), C-handoff (the PreCompact registration is removed; the handoff CLI modes stay for resume notes).

Statements: K and F as in §1; C-dispatch "Every agent dispatch names a model and an effort."; C-handoff "Snapshot in-flight work before compaction."; C-isolation "A session edits only in its own worktree; the live keel and overlay checkouts move only by a user-run fast-forward merge."; S-jdk "Maven builds pin the JDK version the repo requires." `why_not_stronger`: K4 "Ambiguity is semantic; no deterministic trigger exists."; K5 "Readability needs judgment; lint-checkable parts descend per repo."; F-mod-trust "A mod runs inside Claude Code ahead of every hook, so no hook can stop it; smoke check mod-trust FAILs on an unreviewed one." Charter justifications (v1 evidence) are in `ledger.tsv`.

### (c) Evidence

Path: `$KEEL_DATA_DIR/state/keel/evidence/<kind>/<owner>__<repo>/<evidence_id>.json` (review, tests, smoke) or `…/evidence/<kind>/<evidence_id>.json` (approval, ack). Dirs 0700, files 0600, atomic write (temp + rename), never modified.

`evidence_id` = `<kind>-<YYYYMMDDTHHMMSSZ>-<8 hex>`; `run_id`/`root_run_id` match `^[A-Za-z0-9._-]{8,64}$`; shas and tree ids 40 hex; timestamps UTC `YYYY-MM-DDTHH:MM:SSZ`. All kinds: `schema` (1), `kind`, `evidence_id`, `created_at`, `expires_at` (+ 14 days).

| Kind | Additional keys |
|---|---|
| review | `repo`, `repo_root`, `run_id`, `root_run_id`, `since` (previous review `evidence_id` or null), `since_tree` (or null), `review_base`, `head` (sha or null), `snapshot_tree` (or null), `reviewed_tree`, `review_kind` (`lens-review` \| `single-lens`), `verdict` (`PASS` \| `NEEDS_FIXES`), `no_test_reason` (string or null, (d)), `paths` (`[{"path","blob"(null = deleted),"mode"}]`, deleted mode `000000`), `source` (`{"session_id","agent_id","agent_type","transcript_path","agent_transcript_path","via":"SubagentHandback"\|"SubagentStop"}`) |
| tests | `repo`, `repo_root`, `run_id`, `head`, `tree`, `cmd` (argv list), `exit` (0), `count`, `framework`; `superproject` (the origin `keel test` ran from) on a submodule's evidence only |
| smoke | `repo`, `repo_root`, `run_id` (smoke run), `tree` |
| approval, ack | `root_run_id`, `heads` (`{"<owner/repo>": "<review evidence_id>"}`), `source` (`cli`), `session_id` (null) |

The gate ignores expired evidence. `keel evidence gc` deletes expired files; ship-gate runs it at most once per 24 h (stamp `$KEEL_DATA_DIR/state/keel/gc.stamp`), failures ignored.

### (d) Reviewer report format

```
VERDICT: PASS
<findings, notes; MUST include a `git diff --stat` summary line such as "3 files changed" so report-gate's K2 check sees evidence>
KEEL-EVIDENCE: {"v":1,"repo_root":"/abs/repo","review_base":"<40hex commit>","head":null,"snapshot_tree":"<40hex tree>","since":null,"run_id":"rv-…","root_run_id":"rv-…","review_kind":"lens-review"}
```

- Line 1 is exactly `VERDICT: PASS` or `VERDICT: NEEDS_FIXES` (trailing whitespace ignored); else no evidence.
- One `KEEL-EVIDENCE: ` line per repo: single-line JSON with exactly `v, repo_root, review_base, head, snapshot_tree, since, run_id, root_run_id, review_kind`, optional `no_test_reason` (one line; the only K3 escape besides a comment-only deletion, 5.4; lens-review does not emit it yet). Exactly one of `head` / `snapshot_tree` non-null. `review_base` = the merge-base sha diffed from; `since` = the tree a delta diffed from, else null; lens-review's prepare fails when `since` is not a tree object. Root: `root_run_id == run_id`.
- Lenses read diffs against the snapshot tree id (`keel snapshot`), never the live working tree.
- lens-review args: `runId` (optional; default `rv-<UTC stamp>-<6 hex>`), `rootRunId` (required when any diff has `since`); unknown keys rejected (no free-text `context`). Briefs carry no author claims: `requirement` (the request as stated) to every lens, labelled not evidence; `readingGuide` only to the readable-code lens (appended to a caller-supplied one), labelled claims to check; caller `guardrails` to every lens and the verifier. `readingGuide` or `guardrails` text asserting its own correctness (tests pass, LGTM, "we verified", works correctly, …) fails the run before any agent starts; `requirement` is the user's request, so a goal it states is not screened.
- A merge-blocking (high/medium) finding carries a `repro`: command or input with observed and expected result, or `static: <what> at file:line`. The verifier runs command repros; one not showing the failure refutes the finding. No repro → non-blocking (`no repro`).
- Each finding and each verifier decision may carry `origin` (`introduced` | `pre-existing`, judged against `git show <review_base>:<path>`). Only when both say `pre-existing` is the finding listed under `Pre-existing (present at the review base; not merge-blocking)` and left out of the verdict; otherwise it is introduced.
- `keel review prepare` also prints `needs_fixes_rounds`: the NEEDS_FIXES links in the newest recorded chain of the request's `rootRunId` (0 without one). lens-review adds this review when it is NEEDS_FIXES, returns the sum as `needsFixesRound`, and when this review is NEEDS_FIXES and the sum is 3 or more adds `Step back: NEEDS_FIXES round <n> on root <root_run_id> (cap 3). …` after `Refuted`. The verdict is unchanged; a missing or non-integer count is 0.
- A PASS report adds `Owner approval, in your own terminal once the tests are green: keel approve <root_run_id>` after `Refuted`, so the owner can copy the command. The workflow never runs it; git-guard still denies an agent's `keel approve`.
- `keel review prepare` also prints `risk_class`: the heaviest tier (`risk.classify` with the repo's gated row and risk rules) across the reviewed diffs, or null when any repo has no gated row. lens-review sets audit and verification effort from it: `medium` for smoke-only, light and standard, `high` for heavy, null or an unknown value; an explicit `effort` wins. The result returns the chosen `effort`.
- Every report value is one line: a `repo_root` with a quote, control or line-separator character is rejected; agent text and lens keys are flattened.

### (e) CLI contracts

Exit codes: 0 ok · 1 negative result · 2 usage error · 3 refused (validation or provenance) · 4 no tests recognized · 70 internal error. Machine output: one JSON object on stdout; human messages on stderr.

| Command | Args | Behavior | stdout |
|---|---|---|---|
| `keel test -- <cmd…>` | argv after `--`, no shell (`bash -c '…'` for pipes) | snapshot repo tree and each checked-out submodule's tree (nested too) before and after; stream output; counts from `Tests run: N` (surefire totals), `Ran N tests`, TAP `# pass N`, node spec `ℹ pass N`, `N passed` (not on vitest `Test Files` or jest `Test Suites` lines); evidence only if exit 0, count > 0, tree unchanged; then also one tests evidence per unchanged submodule under its own origin, with its own tree and `superproject`; always append `keel-tests.jsonl` | command output; last stderr line `KEEL-TEST {"run_id","count","exit","evidence_id","submodule_evidence"}` (`submodule_evidence` = origin → evidence_id). Exit = the command's; 4 if 0 with count 0 |
| `keel approve <root_run_id> [--read]` | `--read` writes `ack` | each repo's chain head for the root; refuse (3) if none or any head not PASS | `{"evidence_id","kind","root_run_id","heads"}` |
| `keel snapshot <repo>` | repo path | temp-index `read-tree HEAD; add -A; write-tree` (`--work-tree` = repo root); real index untouched; works in submodules | `{"repo_root","tree"}` |
| `keel evidence write-review` | stdin `{"keel_evidence":{…(d)…},"verdict":"PASS"\|"NEEDS_FIXES","source":{…(c)…}}` | validate keys; provenance (5.6); `repo` from origin; objects exist; `reviewed_tree` = `head^{tree}` or `snapshot_tree`; `paths` by `git diff-tree -r -z --no-renames` from `review_base` (root) or `since_tree` (delta); delta `since` = same repo and root review with `reviewed_tree == since_tree`, else 3; root needs `root_run_id == run_id`; idempotent on (repo, run_id, reviewed_tree) | `{"evidence_id","repo","paths":n}` |
| `keel evidence write-smoke` | `[--repo <path>] [--run <smoke run_id>]` (default cwd, latest line) | refuse (3) if that run failed or missed the repo | `{"evidence_id","repo","tree"}` |
| `keel evidence show` | `[--repo <path>] [--root <id>]` | read-only | `{"repo","chains":[{"root_run_id","head_evidence_id","verdict","review_kind","paths":n,"approved":bool,"acked":bool}],"tests":[ids],"smoke":[ids]}` |
| `keel evidence gc` | — | (c) | `{"deleted":n}` |
| `bin/link` | none = dry run; `--write [--adopt] [--force] [--accept-drops <file>] [--allow-worktree]`; `--check`; `--unlink` | below | `{"actions":[{"op":"symlink"\|"copy"\|"replace-link"\|"remove-link"\|"write-claude-md"\|"merge-settings"\|"set-hooks-path"\|"restore-settings"\|"remove-owned-settings"\|"restore-claude-md","path"}],"problems":[{"kind":"link-missing"\|"link-wrong"\|"copy-missing"\|"copy-drift"\|"link-instead-of-copy"\|"dangling"\|"target-occupied"\|"claude-md-drift"\|"settings-drift"\|"gate-onfailure-missing"\|"hook-unregistered"\|"hookspath-drift"\|"settings-unadopted"\|…,"path","detail"}]}`, the dry run adds `"dropped":[<drop line>…]` (empty unless `settings-unadopted`) and `"claude_md_bytes":n` (the generated CLAUDE.md, whether or not it would be written); `--check` exits 1 on any problem |
| `measure/run <id>` | `[--since YYYY-MM-DD]` (default today − 60 days) | `fires:<rule_id>` = in-window fires lines with that rule_id, outcome not `error`/`contract-miss`/`warn`, `kind` not `procedural`, `session` a session_id or `-`; `evals:<id>` = passing `keel-evals.jsonl` lines; `run:<runner>` = keel or overlay `measure/metrics/<runner>` printing `{"count","items"}` (keel ships `C-review-command`: one item per distinct `run_id` of review evidence with `review_kind` `codex-lens-review` created in the window, read from the evidence files, which the 14-day evidence expiry bounds); `exists:<repo path>:<ref>:<path>` = `git -C <repo path> show <ref>:<path>` succeeds → 1 item | `{"id","metric","count","items":[…],"status":"PASS"\|"FAIL"\|"GRACE"}`; exit 0 PASS/GRACE, 1 FAIL, 2 unknown id |
| `measure/smoke` | `[--json-only] [--candidate]` | checks below; append `keel-smoke.jsonl` (`--candidate`: `candidate: true`) | `{"run_id","ok","count","cap","assertions":[{"check","scope","status":"PASS"\|"FAIL"\|"WARN"\|"GRACE","detail"}]}`; exit 1 on any FAIL |
| `measure/propose` | `[--model-upgrade <model>]` | §4 | `{"proposals":[{"id","action":"demote"\|"retire"\|"extend"\|"recheck"\|"rereview","from","to","reason"}]}` |
| `measure/boundary` | `--staged` \| `--range <a>..<b>` \| `--paths <p>…`; `[--generic-only]` | added lines and commit messages vs overlay lexicon (case-insensitive substring) + regexes + `measure/boundary-generic.tsv` (`name<TAB>regex`: secrets, private IPs); without `--generic-only` a missing or 0-rule lexicon is error 2. `--staged`/`--range`: names from `git diff --name-only -z --no-renames --diff-filter=d`, so binary and empty files are scanned by name (line 0). `--paths`: a directory expands to its tracked files (`git -C <dir> ls-files -z`), outside a work tree to every file except `.git` entries; an uninitialized submodule (empty gitlink dir) contributes nothing, an initialized one its own tracked files; a directory with files on disk but none tracked is error 2 | `{"scanned":n,"hits":[{"file","line","rule"}]}`; exit 1 on hits |
| `measure/evals/eval <id>` | `--model M [--split train\|holdout] [--case ID] [--repeat N=3] [--dry-run] [--timeout-seconds S=300]`, or `--regrade RAW_DIR` | each case of `measure/evals/<id>/{train,holdout}.tsv` (`id kind expect prompt`; keel then overlay, duplicate ids refused; language-specific cases live only in the overlay) runs N times through `claude -p` (hooks off, no MCP, Bash denied, acceptEdits, max-turns 8) in a fresh git copy of `<id>/repo` (folder and commit author named after the README's `# ` title; `app` when there is no readable title or it holds eval, test, judge, fixture, keel or candidate, so the session sees no meta word); a case passes with ⌈2n/3⌉ runs, a split when every clear case and ⌈2k/3⌉ ambiguous cases pass, the suite when both splits pass; full run → one `<id>` line (`<id>-v1baseline` unless `<config dir>/skills/<skill>` links into KEEL_HOME and CLAUDE.md is generated) + `<id>.case` lines; subset → `<id>-partial`; any fault → nothing written; raw runs in `logs/keel-eval-<id>-<ts>-<hex>/`; `--regrade` grades a raw dir's saved streams again with the current grader and calls no claude (a raw dir whose cases no longer match the case files, or whose runs.jsonl is missing or malformed, exits 2; `<id>` only for a full run holding every current case N times, else `<id>-partial` for the cases it holds runs of); hand-run only; holdout prompts never printed | `{"eval_id","rule_id","pass","written","model","raw_dir","splits","cases","faults","skill"}` plus `"leftover_unknown"` (runs whose older record cannot say whether a project dir was left behind) on `--regrade`; exit 0 pass, 1 fail or fault, 2 usage/data |
| `measure/evals/review-eval` | `[--split train\|holdout] [--case ID] [--repeat N=3] [--model M=sonnet] [--timeout-seconds S=1800] [--dry-run]`, or `--regrade RAW_DIR` | scores the reviewer (lens-review through adversarial-audit) on `measure/evals/review/cases/<case>/` (keel's invented samples, then the overlay's incident cases; duplicate ids refused): `base/` committed, `change.diff` applied as the next commit in a fresh repo named `app`, then `claude -p` (hooks on, Edit/Write denied) runs lens-review with `diffs [{repo, base, head}]`, plus `requirement` and the lenses `caller_skill` fires when the case gives them; the result is read from the session's own workflow record (`<config dir>/projects/<repo slug>/<session>/workflows/*.json`, `workflowName` lens-review), whose project dir is then removed. `expect.json` = `lens, must_find, source, split, locations:[{file,line}]` (+ optional `caller_skill`, `requirement`); `lens` control = clean case with no locations. A defect run is a hit when a `blocking` finding's `quote` names a location's file (absolute, relative or a trailing part; a bare `:line` counts when the finding's `file` is it) at a line range within 3 lines of it; a clean run is noisy on any `blocking` finding. A run with no completed record, an ERROR verdict or a timeout is a fault, never a miss. Every case repo is built before any review (a case that does not build or names a line past its file's end exits 2). Full run without faults → one `keel-review-eval.jsonl` line; raw runs in `logs/keel-review-eval-<ts>-<hex>/`; `--regrade` grades the saved records again and reports how many grade the same; hand-run only | `{"full_run","repeat","reviewer":{"lens-review.js","adversarial-audit.js": sha256},"raw_dir","numbers":{"train"\|"holdout":{"defect_runs","hits","recall","clean_runs","noisy_runs","noise_rate","blocking_per_clean_run","recall_stdev"},"case_agreement","headroom"},"faults","cases"}`; `--regrade`: `{"regraded_from","runs","same_grade","numbers"}`; exit 0 measured (regrade: all the same), 1 faults or a changed grade, 2 usage/data |
| `measure/weekly` | — | §6 | `{"repo_layer_rules","always_loaded":{"claude_md","memory_indexes"},"defects":{…},"proposals",…}` |
| `skills/readable-code/scripts/rule-checks.ts` (caller: review-engine's rule-checks lens) | `--repo <abs path> --base <commit> [--head <commit\|tree>] [--module-repo <repo>]...`; `--self-test` | below | text, below |

`bin/link`:
- `--write` refuses (3) when `settings/core.json` or a declared fragment is missing, a target is a real file or foreign link, or owned keys drifted since the last write (hash in `$KEEL_DATA_DIR/state/keel/link-state.json`) unless `--force`. Without `link-state.json`, owned keys differing from the live ones exit 3 unless `--adopt`, which prints every item it would drop (each `permissions.allow/deny/ask` entry, `defaultMode`, each env key as `env <NAME> (removed)` or `env <NAME> (value changed)`, never its value, every live hook entry whatever its type, compared by (event, matcher, full hook object), labelled `hooks.<event> <command>` for command hooks) and refuses unless all are in `--accept-drops <file>` (one listed line per line, verbatim; blank and `#` lines skipped). The dry run lists the same lines under `dropped`. A refused `--write` prints the drops before its blocking problems and, unless a problem no flag lifts remains, the `--write` that lifts them all (`--adopt`, `--force`, `--accept-drops <file>` as needed, and `--allow-worktree` when this run was given it). Each settings write first copies `settings.json` to `state/keel/link-backup/<ts>-<pid>/settings.json` (0600). `--force` moves a non-keel CLAUDE.md to `link-backup/<ts>-<pid>/CLAUDE.md`; `link-state.json` records the first such move. It sets `git -C $KEEL_HOME config core.hooksPath githooks`.
- A target under `scheduled-tasks/` is written as a regular copy of its source, never a symlink (the desktop app refuses to open a symlinked task file and skips the run). A keel link there is replaced by the copy; a copy that differs from its source (`copy-drift`), a foreign link or a directory there exits 3 unless `--force`, which moves it to `link-backup/<ts>-<pid>/<target>` first. `--unlink` leaves copies in place.
- `--unlink` removes only links into `KEEL_HOME`/overlay and a generated CLAUDE.md with a matching header, deletes `link-state.json`, and treats settings.json as recorded there: puts the owned keys (`hooks`, `permissions`, `env`) of the backup from before keel's first write into the live file, an owned key the backup lacks removed, while the other keys keep their current bytes and order, as `--write` keeps them (`restore-settings`); if that write created the file, removes the owned keys and keeps the rest (`remove-owned-settings`); a live file that is not a JSON object gets the whole backup back (`restore-settings`), or stays untouched when that write created it; no record or no live file → untouched. It moves the CLAUDE.md recorded as moved aside back when that copy still exists and no CLAUDE.md is in its place (`restore-claude-md`, with `from`); otherwise it only removes the generated one. Before touching settings.json it saves the live file to `link-backup/<ts>-<pid>/settings.before-unlink.json` (0600) and prints the v1 restore command (`git -C <data dir> checkout v1-final -- <paths>`, only paths the tag holds), naming settings.json and CLAUDE.md unless restored from a backup.
- `--check` also reports a gate registration lacking `onFailure:"block"` or a numeric `timeout` (`gate-onfailure-missing`), an active `layer=hook` row whose `enforced_at` hook is unregistered in the merged settings (`hook-unregistered`), `core.hooksPath` drift (`hookspath-drift`).

`rule-checks.ts`: signal-only regex checks over the diff's added lines (v1 rule-checks without company lenses); a signal is a candidate the lens judges. Test paths (the 5.4 set) raise no line or size signal and do not count toward the diff signal; git output is decoded as UTF-8 with replacement. `--head <commit>`: merge-base(base, head) → head; `--head <tree>` (a `keel snapshot` tree): `--base` as given (the review's `review_base`) → that tree via `git diff-tree`, scanning exactly the reviewed content; no `--head`: merge-base(base, HEAD) → working tree plus untracked files. Submodules whose gitlink changes are scanned recursively; a changed gitlink whose submodule is not checked out is scanned old→new pin in the first `--module-repo` holding both commits (only with `--head`), otherwise it is `blocked`. lens-review passes the other reviewed repos as `--module-repo`. Output (not JSON): zero or more `signal <ID> <file:line> <text>` lines, then exactly one last line `summary repos=<n> scanned_lines=<n> signals=<n> unscanned=<csv|none> blocked=<csv|none>`. `<ID>` is always `K5.<n>` (n = R-number), never `R<n>` or v1 `T<n>`; `<file:line>` relative to `--repo` (submodule paths prefixed) or `(diff)` for a whole-diff signal; `<text>` ≤ 160 chars. Exit 0 = scanned; 2 = usage error, crash (`blocked=.(crashed: <ErrorType>)`) or any repo unscanned (`blocked` ≠ `none`), which the lens reports as a finding, never clean. lens-review counts its built-in rule-checks lens as not run (NEEDS_FIXES) unless the lens notes quote exactly one `summary` line per reviewed repo, each `blocked=none`.

K4 grading (`measure/evals/eval K4`): `claude -p` disables the AskUserQuestion tool, so each run appends one system prompt line (`--append-system-prompt`, evalkit runner QUESTION_PROTOCOL) asking the model to put each question for the user on its own line starting with `QUESTION:`. A run asks when it calls the ask tool, when a line outside fenced code starts with `QUESTION:` (after any run of the prefixes `-`, `*`, `+`, `>`, `#` or a number followed by `.` or `)`, then optional `**` or `__` bold), or when a `# Refined request` heading (the prompt-refine brief) appears; it answers when the expect token appears outside fenced code before the first `QUESTION:` line (a follow-up question may come after the answer; options under a question are not an answer). No language-specific phrases: the marker is the same whatever language the model replies in. The protocol line is identical for the v1 baseline and keel runs.

smoke checks (kind × scope): ledger-format, id-unique, caps (each), id-tagging (principles, personal, each skill; 0 rule lines checked across all skills = FAIL), fires-rule-ids, contract-miss-cap (more than 20 `contract-miss` fires lines dated today or yesterday FAILs, naming the count per hook), rule-of-two, metrics (every `run:` runner of the rows starts before the rows are judged, at most 6 at a time, each with its own 120 s timeout, after which the runner is killed with its whole process group; rows are then judged in ledger order, so the assertion is the one a sequential run prints), expiry (WARN), boundary (keel tracked files; missing or empty lexicon FAILs), link-integrity (`bin/link --check`, incl. the CLAUDE.md cap; with `--candidate` instead the link tool's dry run with `KEEL_DATA_DIR` = a fresh empty temp dir (removed after) and the same `KEEL_HOME`/`KEEL_OVERLAY_DIR`, FAIL on any problem other than those an empty data dir always has: `link-missing`, `copy-missing`, `settings-drift`, `claude-md-drift` "generated CLAUDE.md is missing"; a refused or crashed dry run FAILs), wired-fires, dangling (symlinks in `$KEEL_DATA_DIR/{skills,commands,agents,workflows,bin,mcp}`), mod-trust, assertion-cap.
- wired-fires, per active `layer=hook` row: take the command of the live settings.json registration matching the fixture's `hook_event_name`/`tool_name`; run it in a fresh temp dir (`KEEL_DATA_DIR=<temp>/data`, `KEEL_OVERLAY_DIR=<temp>/overlay`) on the bad fixture: it must write a fires line with that `rule_id` and the `expect` outcome; on each hook's good fixture it must exit 0 with no fires line. Writing the real fires log FAILs; 0 rows recognized = FAIL. Fixtures `tests/hooks/fixtures/<row id>.bad.json` in the checkout owning the row, `<hook>.good.json` in `KEEL_OVERLAY_DIR` for an overlay hook (its registered script lies under `KEEL_OVERLAY_DIR` or that dir's path in the overlay repo's main worktree, where installed settings point even when `KEEL_OVERLAY_DIR` is a linked worktree), else in keel: `{"payload": <hook stdin; {{TMP}} = the temp dir>, "expect": <outcome, bad only>, "setup": [<shell commands run in the temp dir first>]}`; `tests/measure` checks the shipped ones against shipped settings.
- mod-trust (F-mod-trust): `$KEEL_CLAUDE plugin list --json` MUST print `[{"id","installPath"},…]` (strings), else WARN `mod check could not run: …`, never PASS. A plugin is a mod when `<installPath>/hooks/hooks.json` lists a non-empty `modules`, or exists but cannot be read, parsed as an object, or holds a `modules` that is not a list of strings (`null` included; an absent key lists none). A mod passes when its id is in overlay `reviewed-mods.txt`, or when its installPath, links and `..` resolved, lies inside the overlay's main worktree (`KEEL_OVERLAY_DIR`, or its path in the repo's main worktree when it is a linked worktree, since installed mods link from the live overlay; `reviewed-mods.txt` is still read from `KEEL_OVERLAY_DIR`) and is tracked there with no `git status --porcelain` output, and every listed module (relative to `hooks/`) is a tracked file, so an ignored build output does not pass; FAIL lists the other ids and says to read each with `claude plugin validate <dir>`, then list its id.
- githooks (`git config core.hooksPath githooks`): `pre-commit` runs `measure/boundary --staged`, `pre-push` `measure/boundary --range` over the pushed commits.

### (f) Log line schemas (`$KEEL_DATA_DIR/logs/`, JSONL, append-only)

| File | Keys |
|---|---|
| `keel-fires.jsonl` | `ts, rule_id, hook, outcome` (`deny`\|`warn`\|`pass`\|`record`\|`error`\|`contract-miss`), `session` (session_id or `-`); optional `repo, risk, head, root_run_id, files, lines, detail` (≤ 200 chars, never secrets or prompt text), `kind` (`procedural`: a procedure deny, not a detection); `files`, `lines` (numstat added+deleted) on every `risk` pass or deny line |
| `keel-fires-synthetic.jsonl` | the `keel-fires.jsonl` keys, for a session that is neither a session_id nor `-` (a probe) writing the real `~/.claude` data dir; read by no metric |
| `keel-tests.jsonl` | `ts, run_id, repo, repo_root, cmd, exit, count, framework, tree, evidence_id, submodule_evidence` (origin → evidence_id) |
| `keel-evals.jsonl` | `ts, eval_id, rule_id, case, pass, model`, plus `regraded_from, grader` (raw dir name, HEAD of the checkout running the grader with `-dirty` when its `measure/evals` differs) on `--regrade` lines (`<id>.case`, `<id>-partial`, `<id>-v1baseline` are inert for `evals:<id>`: exact match) |
| `keel-review-eval.jsonl` | `ts, reviewer, repeat, numbers, raw_dir` (one line per full review-eval run without faults; read by no metric) |
| `keel-smoke.jsonl` | `ts, run_id, ok, count, failed:[{check,scope,detail}], trees:{"<owner/repo>":"<tree>"}` (keel and overlay checkouts); `candidate: true` only on a `--candidate` run (not live health) |

`ts` is UTC `YYYY-MM-DDTHH:MM:SSZ` (`--since` compares the first 10 characters); `hook` is a (g) hook name. Fires `rule_id` is closed: (b) seed ids plus overlay `git-guard/repo-rules.tsv` `rule_id`s; anything else, `-` included, FAILs smoke `fires-rule-ids`. A deny or warn logs one line per `[ID]` in its message, a pass one line; a non-decision call (e.g. Bash that is no push, merge or protected write) logs nothing.

| Hook | Decision | rule_id | outcome |
|---|---|---|---|
| ship-gate | review chain, base scope, coverage, provenance, approval, unattributable push/merge (5.1, 5.2, 5.4) | K1 | deny / pass |
| ship-gate | tests evidence, `tests=none` with standard/heavy, logic without test (5.4) | K3 | deny |
| ship-gate | `single-lens` chain link, smoke-only coverage (5.4) | risk | deny |
| ship-gate | any passing push or merge incl. `off`, unlisted, empty C (read by §6; sets `repo`, `head`, `risk`/`root_run_id` when computed) | risk | pass |
| ship-gate | `gh pr merge` without `--match-head-commit`, merge-preflight (5.2), `push --all`/`--branches`/`--mirror` in a gated repo, a push or merge reaching a gated repo from a clone of another repo | F-irreversible | deny |
| ship-gate | registry absent (once per session), `gh pr create` early warning | K1 (early warning: first missing requirement's id, else K1) | warn |
| ship-gate | gc run | K1 | record |
| git-guard | AI attribution | F-attribution | deny |
| git-guard | secrets (`measure/boundary --staged --generic-only` hits; known values in written or committed content) | F-secrets | deny |
| git-guard | force push | F-force-push | deny |
| git-guard | evidence-store writes, `keel approve`, `keel evidence write-review` (5.6) | K1 | deny |
| git-guard | hook switch-off, fires-log protection (5.6) | F-hookskip | deny |
| git-guard | live-checkout writes, state-moving git commands (5.6) | C-isolation | deny |
| git-guard | overlay repo rules | the row's `rule_id` | deny |
| report-gate | evidence token (done/pass claim without evidence) | K2 | deny / warn / pass |
| report-gate | `[SCOPE]` check | K5 | deny / warn |
| report-gate | review evidence written / refused by `write-review` / skipped because the reviewer edited | K1 | record / warn |
| report-gate, ship-gate | expected payload field missing (5.6) | the hook's first id here | contract-miss |
| model-assign | model/effort check and rewrite | C-dispatch | deny / record / pass |
| handoff (CLI) | snapshot written | C-handoff | record |
| env-preflight | JDK check and rewrite | S-jdk | deny / record / pass |
| any | the hook's own internal error | the running check's id, else the hook's first id here | error |

### (g) Settings fragments and hook registration

A fragment is a JSON object with only `hooks`, `permissions`, `env`, in Claude Code settings shape. Strings may use `{{KEEL}}` (KEEL_HOME), `{{OVERLAY}}` (KEEL_OVERLAY_DIR), `{{DATA}}` (KEEL_DATA_DIR), expanded by `bin/link` to absolute paths; any other `{{…}}` is an error. Order: `settings/core.json`, `stacks/<name>/settings.json` per overlay `stacks.txt` name (sorted), overlay `settings/*.json` (sorted). `hooks.<event>` arrays concatenate; `permissions.allow|deny|ask` concatenate, first occurrence kept; other `permissions` keys and `env` keys: later wins, conflicts reported. The result replaces the owned keys of `$KEEL_DATA_DIR/settings.json`; other keys and their order stay byte-identical; atomic write.

```json
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node {{KEEL}}/hooks/ship-gate/ship-gate.ts","timeout":60,"onFailure":"block"}]}]}}
```

| Hook | Event | Matcher | Command | Timeout | On own error | On process failure |
|---|---|---|---|---|---|---|
| ship-gate | PreToolUse | `Bash` | `node {{KEEL}}/hooks/ship-gate/ship-gate.ts` | 60 | 5.7 | `"onFailure":"block"` |
| git-guard | PreToolUse | `Bash\|Edit\|Write\|NotebookEdit` | `node {{KEEL}}/hooks/git-guard/git-guard.ts` | 10 | deny if the payload looks like a commit, push, PR text, keel command, hook skip or protected write, else pass | `"onFailure":"block"` |
| report-gate | PreToolUse | `SubagentHandback` | `node {{KEEL}}/hooks/report-gate/report-gate.ts` | 30 | pass, logged | fail open (ship-gate K1 already denies without evidence) |
| report-gate | SubagentStop | — | same | 30 | pass, logged | fail open (SubagentStop ignores `onFailure`) |
| model-assign | PreToolUse | `Agent\|Workflow` | `node {{KEEL}}/hooks/model-assign/model-assign.ts` | 10 | pass, logged | fail open |
| env-preflight | PreToolUse | `Bash` | `node {{KEEL}}/stacks/spring-maven/hooks/env-preflight.ts` | 10 | pass, logged | fail open |

- "On process failure" = Claude Code's action when the hook process crashes or times out. Only the two gate registrations carry `"onFailure":"block"` and an explicit `timeout` (else `link --check` `gate-onfailure-missing`); a broken blocking gate blocks every matching call, and the way out is the user's terminal.
- Each registered `timeout` exceeds the longest subprocess budget in that hook: git-guard gives each git call and the boundary scan 8 s; ship-gate gives each git call and fetch 20 s and `gh pr view` 12 s (`keel snapshot` and `keel test`, which no hook runs, give each snapshot git call 300 s); a merge path that still runs past its 60 s is killed and `onFailure: block` denies it; each hook's test reads the registered timeout from `settings/core.json`.

Hook protocol:
- stdin = one JSON payload: `session_id, transcript_path, cwd, permission_mode, hook_event_name`; `agent_id, agent_type` only inside a subagent; PreToolUse adds `tool_name, tool_input, tool_use_id`; SubagentStop `agent_id, agent_transcript_path, agent_type, last_assistant_message, stop_hook_active`. Inside a subagent `transcript_path` is the MAIN session's.
- report-gate at `PreToolUse[SubagentHandback]` reads the report from `tool_input.message` and MUST derive the agent transcript as the first match of `<dirname(transcript_path)>/<session_id>/subagents/**/agent-<agent_id>.jsonl` (recursive, components escaped; workflow agents sit in a subdirectory); at SubagentStop it uses `agent_transcript_path` and `last_assistant_message`, or, when that field is absent or empty, the text the agent wrote after its last tool use in the agent transcript. No match or field missing → no review evidence, K1 warn.
- Deny = exit 2, message on stderr. Warn = exit 0, stdout `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"<msg>"}}`. SubagentStop block = stdout `{"decision":"block","reason":"<msg>"}`. Input rewrite (model-assign) = `hookSpecificOutput.updatedInput`.
- Message (`hookkit/protocol.ts`): line 1 `[<ID>] <hook>: <summary>` (`<ID>` = the first bullet's), then one `- [<ID>] …` line per finding; a deny ends with one last line (5.7), a warn does not; ≤ 2000 characters (a longer deny is cut before its last line, which survives).

Ported from v1 minus company branches: report-gate = evidence-token and `[SCOPE]` checks, hand-back/stop dedup, review evidence (5.6). git-guard = attribution regex, parser, fail-closed; secrets via `measure/boundary --staged --generic-only` on `git commit`; force push (`--force`, `-f`, `+refspec` denied; `--force-with-lease` only to the integration base, `main` or `master`); 5.6 protections; overlay repo rules. model-assign = v1 agent-model-assign. handoff = CLI modes only (its PreCompact `--auto` registration was removed with C-handoff), snapshots in `$KEEL_DATA_DIR/handoff/`. env-preflight = repo→JDK map as overlay data.

### (h) Overlay data formats (invented example values)

`gated-repos.tsv`
```
origin	gate	integration_base	risk_rules	tests	push_approval
acmecorp/storefront	code	develop	acme	required	false
acmecorp/deploy-config	code	main	acme	required	true
example/keel	code	main	keel	required	false
example/keel-overlay	code	main	overlay	required	false
example/notes-data	off	main	-	none	false
```

`risk-rules.tsv` (`path_glob`: `fnmatch.fnmatchcase` on the repo-relative path, `*` crosses `/`; class ∈ `light|heavy|smoke-only`)
```
set	path_glob	class
acme	src/*/billing/*	heavy
acme	db/migration/*	heavy
acme	*.css	light
keel	docs/*	light
keel	*.md	light
overlay	settings/*	smoke-only
overlay	ledger.tsv	smoke-only
```

`git-guard/repo-rules.tsv` (`origin_glob` vs the repo key; `deny-commit` = any commit there; `deny-path` = a staged or pushed path matching `pattern`)
```
origin_glob	action	pattern	rule_id	message
acmecorp/platform-root	deny-commit	-	O-parent	Commit inside the submodule, not the parent repo.
acmecorp/*	deny-path	*.sql	O-files	SQL files go through the DBA handoff, not git.
```

`git-guard/known-values.tsv` (`file`: config-file glob whose secret-named keys (`pass`, `pwd`, `secret`, `token`, `key`, `credential`, `auth`) give values; `env`: a variable whose value counts; values under 6 characters skipped)
```
source	pattern
file	~/.config/acmecorp/*.env
env	ACME_API_TOKEN
```

`stack-data/spring-maven/jdk.tsv`
```
origin_glob	jdk
acmecorp/*	17
```

`boundary/lexicon.txt` (one case-insensitive substring per line), then `boundary/regex.txt` (one regex per line, in JavaScript `RegExp` syntax without flags; a leading `(?i)` makes the line case-insensitive, and `measure/boundary-generic.tsv` follows the same rule):
```
ACMECORP
TKT-
```
```
\bTKT-\d{3,}\b
\b10\.250\.\d{1,3}\.\d{1,3}\b
```

`reviewed-mods.txt` (installed plugin ids from `claude plugin list --json`, each added after reading `claude plugin validate <dir>`):
```
example-cues@example-market
```

Link manifest (keel `settings/links.tsv`, overlay `links.tsv`); `target` is relative to `KEEL_DATA_DIR`, never absolute or containing `..`:
```
source	target
{{KEEL}}/skills/readable-code	skills/readable-code
{{KEEL}}/workflows/lens-review.js	workflows/lens-review.js
{{KEEL}}/bin/keel	bin/keel
{{OVERLAY}}/commands/example-cmd.md	commands/example-cmd.md
```
Generated `$KEEL_DATA_DIR/CLAUDE.md` = line 1 `<!-- GENERATED by keel bin/link from PRINCIPLES.md + PERSONAL.md. Edit the sources, then run bin/link --write. -->`, then `PRINCIPLES.md`, a blank line, `PERSONAL.md` (if present).

### (i) Environment variables

| Var | Default | Meaning |
|---|---|---|
| `KEEL_HOME` | repo root from the running script's real path | keel checkout |
| `KEEL_OVERLAY_DIR` | `~/git/keel-overlay` | overlay checkout; missing → no overlay data |
| `KEEL_DATA_DIR` | `~/.claude` | logs, state, evidence, transcripts (`projects/`), link targets, settings.json, CLAUDE.md. Readers expand a leading `~` or `~/` in it and in `KEEL_OVERLAY_DIR` to the home directory (`~user` stays as written); review-engine prompts' shell text does not, so give those agents an absolute path |
| `KEEL_GH` | `gh` | gh binary |
| `KEEL_CLI` | `$KEEL_HOME/bin/keel` | keel CLI run by hooks and scripts |
| `KEEL_BOUNDARY` | `$KEEL_HOME/measure/boundary` | scanner run by git-guard and githooks |
| `KEEL_LINK` | `$KEEL_HOME/bin/link` | link tool run by `measure/smoke` |
| `KEEL_CLAUDE` | `claude` | Claude Code CLI run by `measure/smoke` (`plugin list --json`) |

Test isolation (every test running code): a fresh temp dir per test, `KEEL_DATA_DIR=<tmp>/data`, `KEEL_OVERLAY_DIR=<tmp>/overlay` (from `examples/` or inline fixtures), `HOME=<tmp>/home`, `GIT_CONFIG_GLOBAL=<tmp>/gitconfig` (with `user.name`/`user.email`), `GIT_CONFIG_NOSYSTEM=1`, `KEEL_GH=<stub>`, `KEEL_CLAUDE=<stub>` where smoke runs; `KEEL_HOME` = the checkout under test. Each `tests/<track>/helpers.ts` asserts `KEEL_DATA_DIR` is under the temp dir first. No test touches the network or the real `~/.claude`.

### (j) Tests

- TypeScript: `tests/<track>/*.test.ts` and `codex/tests/*.test.ts`, `node --test`, names `<subject>_<expectedBehavior>_<condition>`, given/when/then, a failure-side test per branch; prefer black-box runs of the entry script or CLI as a subprocess. Parity harnesses compare the TypeScript with outputs recorded from the Python 3.15 implementation the TypeScript replaced; the recordings are frozen fixtures (`tests/fixtures/python`, `tests/hooks/fixtures`, `tests/ship-gate/fixtures`, `tests/skills/fixtures`), and the tools that made them survive only in git history; the wrong-type payloads added after 1.0.0 (`tests/hooks/fixtures/hook-parity/adversarial.json`, `codex-hook-parity`) were recorded from the TypeScript hooks and adapter as they were before the typed readers. `measure`, `link` and `lib/evidence` keep only the outcomes of those recordings (exit code, JSON fields, stderr kinds, written files) in `tests/fixtures/measure`, `tests/fixtures/link` and `tests/fixtures/evidence`, and test the cases whose outcome changed with explicit expectations. The Codex adapter keeps comparing its hook, link and config runs with the recordings (`tests/fixtures/python/codex-*`), accepting the listed changed payloads and steps, and pins its input boundaries against the old adapter's outcomes in `tests/fixtures/codex/boundary-recorded.json`.
- Node (review-engine): `tests/workflows/*.test.mjs`, `node --test`; workflow scripts run with stubbed `args`, `log`, `agent`, `workflow` globals.
- Per track: `node --test 'tests/<track>/*.test.ts'` (or `node --test 'tests/workflows/*.test.mjs'`). `bash tests/run-all.sh` runs `node --test` over `tests/**/*.test.ts` and `codex/tests/*.test.ts`, then the workflow tests; exit 1 if any failed.
