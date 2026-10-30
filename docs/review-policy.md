# Shared review policy

Claude and Codex use the same review flow. The author never reviews its own
output. Auditors are separate contexts from the author; finding verifiers are
separate contexts from both the author and the auditor whose findings they judge.

## Candidate and scope

Finish the requested implementation and relevant tests before requesting formal
review. Pin the requirement, repository, Git base and candidate snapshot. Do not
run an ordinary review and then a second formal review of the unchanged candidate:
use the formal review as the independent review. Reuse recorded evidence while
its target and the gate's coverage and freshness requirements still hold.

Use one independent auditor for the complete lens set by default. Split auditors
by lens when risk or scope warrants separate contexts; coverage stays complete.
Each auditor reads the context needed for its lens and reports only actionable
failures within the requirement. A clean lens needs no verifier. A source audit with
findings gets separate verification of its findings together. That verifier
checks the cited evidence, reproduction and relevant callers; it does not repeat
the full audit. Every finding needs an individual evidenced decision. Missing,
duplicate or unavailable decisions cannot establish a clean result.

Keep the required lenses, test obligations, immutable evidence and owner approval
gates. Batching is an execution change, not an exemption from those requirements.
Optional improvements remain non-blocking. Confirmed high/medium failures block.

Review and test PASS establish verification evidence only. Create PRs, including
drafts, only through an explicitly invoked `/ship1` after the owner has run plain
`keel approve <root_run_id>` for the current reviewed candidate. Both conditions
are required: PASS, approval alone, or an ordinary request to create a PR cannot
substitute for `/ship1`; `/ship1` without approval must stop before delivery.
`--read` is acknowledgement, not approval. Never run the owner's approval command;
a Claude PASS report prints it for the owner to copy.
If `/ship1` is unavailable in the current runtime, report the ready state for the
owner to invoke it in a supported runtime; do not emulate its PR step. This applies
to keel's own changes too. Local approved activation does not require a PR, and
`/ship1` does not waive existing review, test or merge-approval gates.

[C-precheck] For a TS/JS diff that changes three or more non-test source files,
run `keel precheck run --repo <path> --base <review base>` after the tests are
green and before `keel review prepare`; run it in the background while writing
the reading guide. Skip it for smoke-only, docs-only and test-only diffs. After a
NEEDS_FIXES with tests findings, run it again before the delta review. Kill each
survived and no-test-reaches mutant with a test or write one line on why no test
can observe it, and fix or note each consumer outside the diff. Pass the output
verbatim as the lens-review `precheck` argument. It is an author claim for the
tests and contract lenses to check, not evidence: it adds no evidence kind, and
"all killed" is not a pass claim. The review reports the precheck as stale when a
non-test path changed after it or an existing test line changed; rerun it then,
and rerun it after adding tests so its survivors are not left open.

## Test runs

The gate's test check (K3) asks for one passing `keel test` run whose recorded
content matches every outgoing changed file. It does not ask for the full suite.
Choose each run by what changed since the last passing run:

- While iterating and after each review fix, run the test files of the changed
  modules and every test that imports, spawns or reads a changed path, found by
  grepping the tests for its file name, plus the tests that import a test helper
  the grep finds: `keel test -- node --test <files>`.
- A smoke-only change (paths the overlay's risk rules class smoke-only, or a repo
  whose gate is smoke) needs no test run; the gate asks for smoke evidence
  instead. A light change (in keel: `docs/*`, `settings/*` and every `*.md`,
  including skills and PRINCIPLES.md) still needs one passing run on its tree in
  a repo whose tests are required: run the tests that read the changed files, or
  the smallest test file that runs when no test reads them.
- Run the full suite (`keel test -- npm test`) once per candidate, before
  requesting its root review, when the change touches code a hook runs:
  `hooks/**`, `lib/**`, `measure/lib/**`, `measure/boundary*`, `codex/hooks/**`,
  `codex/lib/**`, `skills/readable-code/scripts/**`, `githooks/**` or
  `settings/core.json`. This list overrides the light rule for the paths it
  names. Run it in the background: it outlasts the foreground limit.
- After the full suite passed, a fix delta reruns only the tests the fix reaches,
  on the new tree. Do not rerun the full suite to confirm a passing focused run,
  or after a conflict-free merge of two passing sides; rerun the tests on the
  overlap.

## Explain before requesting approval

[K5] Before presenting an owner approval command, explain the candidate in the
owner's language so they can decide with an understanding of the code. Cover:

- The original problem and the behavior before and after the change.
- How a concrete input moves through the entry point, key decisions and side
  effects to its result, with links to the relevant files and lines.
- Why this structure and decision order were chosen, including the constraints
  they preserve and a relevant alternative's tradeoff. Do not invent alternatives
  or claim a comparison was tested when it was not.
- What the tests and independent review establish, their actual evidence, and
  remaining risks or unverified behavior.

Scale the explanation to the change: a trivial or documentation-only change
normally needs two or three sentences on rationale and effect; an ordinary logic
change needs one concrete example and a brief reason for its structure and
branches; a high-risk change also needs alternatives, failure conditions and
verification limits. Prioritize what changes the approval decision. In follow-up
requests for the same candidate, explain only new changes, changed evidence or
remaining questions and link the earlier explanation instead of repeating it.
If the earlier explanation is unavailable, give a brief self-contained recap.
Do not impose a token cap that would hide a material risk.
A file list, test PASS or approval command alone is insufficient. Explain
unfamiliar terms, distinguish intended behavior from verified results, and put
the explanation before the command. This supplements the readable-code
human-understanding gate; it does not grant approval. When no approvable target exists, explain the limitation before
providing the permitted diagnostic command.

## Fixes and later changes

Use a delta from the recorded snapshot under the same requirement and base.
Review the changed lines and affected contracts, reading surrounding unchanged
code when needed. Include every unresolved prior finding in the brief and settle
each with evidence. An unresolved blocking finding still blocks even if its
line is outside the delta. Keep final candidate tests and coverage checks.

Start a full review when the requirement or review base changes, prior evidence
is missing or invalid, or the new scope cannot be assessed as a bounded delta.
Do not restart the entire review merely because a small fix was made.

In a Claude fix delta (a `since` review that carries `priorFindings`), only
impact high is merge-blocking. A prior finding the fix leaves unresolved comes
back at impact high and still blocks; a new medium finding is listed as
non-blocking and goes to the Worklog as a follow-up. Each delta finds fresh
mediums, so letting them block kept chains running for many rounds. A root
review and a delta after a PASS keep high and medium blocking. The Codex
protocol keeps its existing blocking rule.

Reviews do not report code comments, rule-checks K5.14 signals included:
git-guard C-comments denies new and changed comments on the write paths it
parses. The gaps the ledger row C-comments lists are accepted misses.

A Claude review chain that reaches its third NEEDS_FIXES ends its report with a
`Step back` line. Before another fix, reconsider the approach and tell the owner
what keeps failing. `keel review prepare` counts the earlier NEEDS_FIXES links
of the `rootRunId` chain. The line is a prompt for the author and owner; it does
not change the verdict or any gate.

[C-verbatim-fix] A fix that applies a reviewer's exact replacement text
verbatim, and changes nothing else, closes that finding without a delta review.
The reviewer chose the text, so the author does not judge it. The text must come
from a finding that stands, not one a verifier adjusted or refuted. In the report,
name the finding, quote the reviewer's text and show the diff that applied it.
Do not report that finding as unresolved or not re-reviewed. A fix that
paraphrases the text, applies only part of it, applies only the idea, or touches
anything else still needs a delta review. A candidate whose review is recorded as
evidence for an exact tree still needs a delta for the new tree, and that delta
settles the finding.

## Runtime contracts

Claude uses `workflows/lens-review.js` and `workflows/adversarial-audit.js`;
the latter batches verification per source audit with findings. Existing snapshot delta and
report provenance contracts remain in force.

A Claude finding whose failure is already present at the review base is listed as
pre-existing and does not block, but only when the auditor and the verifier each
mark it pre-existing on their own read of the base. If either one does not, it
counts as introduced. A prior merge-blocking finding is introduced. The Codex
protocol records no origin, so its findings keep the existing blocking rule.

Codex uses the version 2 protocol in [codex-review.md](codex-review.md).
It records the completed native audit and verifier sessions. Old-format records
are read-only until their valid references expire; old registration is removed.

Agent-call counts demonstrate batching, not token or latency savings. Measure
actual usage before claiming a reduction in tokens or elapsed time.

## Mechanical work and context

For Claude, run `keel review prepare` with the workflow args as JSON on stdin and
pass its output as `prepared` to lens-review. This pins Git metadata without a
prepare agent. Existing callers without prepared metadata retain the same fallback;
new calls should use the CLI. The reporter remains a low-effort transport required
by the current transcript-backed provenance contract; it performs no judgment.
Do not remove it without replacing that trusted registration path.

Prepare the same request that the workflow will receive, for example in zsh:

```sh
cat > /tmp/keel-review-request.json <<'JSON'
{"diffs":[{"repo":"/absolute/repository","base":"origin/develop"}],"requirement":"The requested behavior"}
JSON
"$KEEL_HOME/bin/keel" review prepare < /tmp/keel-review-request.json > /tmp/keel-review-prepared.json
```

Read both JSON files through the agent's file tool and call
`Workflow({name:'lens-review', args:{...request, prepared}})` with their parsed
objects. Keep all request fields, including custom lenses and delta identifiers.
The CLI pins the candidate without an agent; review reads the pinned Git objects.

Claude audit and verification use `opus`. Their effort follows the change's risk
tier, which `keel review prepare` reports as `risk_class` from the repo's gated
row and risk rules (the heaviest across repos): `medium` for smoke-only, light
and standard, `high` for heavy and `high` when any repo has no gated row or no
tier was prepared. A caller `effort` overrides the tier. Measured on two
standard keel diffs, `medium` caught every merge-blocking finding `high` caught
and dropped only low-impact ones. Fallback preparation
and report transport default to `sonnet` / `low`; `mechanicalModel` overrides
their model independently of `model` and `effort`. Exact report/evidence checks
still reject altered reporter output. Review findings contain diagnosis, evidence,
reproduction and a concise fix direction; replacement patches belong to the
implementation step. Legacy supplied patches retain their existing adjustment
invalidation. Start a fresh Claude session after changing workflow files.

Use concise reviewer briefs with request, target and contracts. Load the code
checklist and relevant full sections, not every reference or legacy manual. Tests
judge regression sensitivity and meaningful failure boundaries, not a fixed count
per branch. Existing-comment cleanup is a separate requested task. Create HTML
only for requested/required document deliverables; keep routine status in chat.

## Approved activation

The owner still approves. New approval records additionally bind the current
candidate commit when its HEAD tree equals the reviewed tree. An agent may then
run only `git merge --ff-only <full-sha>` into a clean live checkout when the
exact commit binding, valid review provenance, final tests and the normal gate
all pass. Branch names, read acknowledgements, older approvals lacking a commit
binding, dirty/non-fast-forward targets and ordinary live edits stay blocked.
The initial installation of this guard change remains owner-run under the old
policy. Hook trust changes, if any, remain an owner action.


## Mechanical comment deletion

A new tree does not require another model review when the only difference from
reviewed content is a mechanically verified deletion of whole ordinary-comment
lines. The gate checks this at consumption time for both review and test coverage;
it does not rewrite evidence, change its timestamp or approve a new chain.
Existing provenance, approval, expiry, base and mode checks remain in force.
Verified comment deletion alone adds no changed-logic test-path obligation.

The conservative built-in recognizer supports a bounded JavaScript, TypeScript and Java
lexical subset; a Python file is never comment-only, so any `.py` change needs fresh evidence. Code and string
bytes stay identical. It accepts whole ordinary prose comments only. It refuses
files with detected notices/directives or non-prose comment markers, inline edits,
docstring deletion, unsupported extensions, JSX, JS/TS slash expressions or angle
brackets, templates, Java Unicode escapes/text blocks, malformed strings/comments
or oversized input. Unsupported cases use the existing review path; this is not an arbitrary
semantic-equivalence waiver. Test code changes and tool-comment changes still
need independent review and appropriate test evidence. Exact-commit activation
approval remains a separate constraint and receives no comment-deletion exemption.

Notebook source/cell markers are tool inputs too; see the
[Databricks source format contract](https://docs.databricks.com/aws/en/notebooks/notebook-export-import).
