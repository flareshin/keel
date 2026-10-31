---
name: readable-code
description: Rules for writing code a human can follow when AI wrote it — reading order, names, hidden flow, state, errors, comments, tests, diff shape and a reading guide. Load before writing or changing code in any repo (Java/Spring, TS/React, Python, shell) and before writing a coding-agent brief. Do NOT use for docs-only or config-only changes.
---

# Readable Code

Use this checklist while writing and reviewing changed code. The complete rules
and exceptions are in [rules.md](references/rules.md); read the sections relevant
to the change or a candidate finding, rather than loading every reference.
Documentation-only and configuration-only changes do not require code-style review.
Use [rule-checks](scripts/rule-checks.ts) for signals; a clean scan is not semantic review.

## Implementation

Before a non-trivial implementation or coding-agent brief, read
[implementation.md](references/implementation.md) for caller-first design and
small behavior slices. Keep existing-code improvement requests in `improve`;
this reference shapes only the behavior and interfaces the current task needs.

## Rules
- [K5] Judge new and changed lines. Existing comments in the files a diff changes go in the `no-comments` pass before review; elsewhere their cleanup is a separate requested task; keep the original requirement bounded.
- [K5.1] Entry methods tell the top-level story at one abstraction level.
- [K5.2] Put callers before callees; follow the language's established reading order.
- [K5.3] Put guards first and keep nesting shallow; inspect the full exception before flagging a limit.
- [K5.4] Use one domain name per concept and normalize external names at boundaries.
- [K5.5] Name behavior and side effects explicitly.
- [K5.6] Name meaningful constants; avoid ambiguous sentinels.
- [K5.7] Split by meaning and by domain knowledge, not execution step; size thresholds are signals, not automatic findings.
- [K5.8] Decide domain rules once; inspect reuse before adding another implementation; derive or test hand-synced lists.
- [K5.9] Make side effects, transactions and rollback behavior visible and verified; a state-changing operation converges when it runs twice or after a run that stopped halfway.
- [K5.10] Give each variable one meaning; prefer immutable state; model a lifecycle as one state value, not agreeing booleans.
- [K5.11] Carry meaning in types; validate untyped external boundaries.
- [K5.12] Handle failures explicitly; do not swallow errors or infer exception types from messages.
- [K5.13] Validate external values once at the boundary, with security exceptions where necessary.
- [K5.14] Write no new or changed code comments except mandatory notices and necessary tool directives; git-guard denies others, line-start or trailing, on Edit, Write, NotebookEdit and Bash cat or tee heredoc writes. Comments are hypotheses, not behavior evidence. Preserve the full rule's exceptions; the `no-comments` pass clears the files a diff changes, and other files are not cleaned unasked.
- [K5.15] Follow the nearest established pattern; explain an approved migration.
- [K5.16] Tests assert observable behavior and meaningful failure boundaries, with expected values derived from the requirement, never recomputed like the code. Existing regression-sensitive tests count; a fixed number of tests per branch does not establish adequacy.
- [K5] A separate context judges the output. New findings need concrete evidence, not taste.

## Delivery

For non-trivial changes, give a concise reading guide: Entry point, Flow, Changed,
Unchanged, Decisions, Rejected, Read first. Explain a size signal or deliberate
exception there. Keep unrelated structural cleanup separate from behavior changes.
For a TS/JS diff of three or more non-test source files, write the guide while
`keel precheck run` works in the background, per the shared review policy.

Before presenting an approval command, explain the problem, concrete flow, why
the structure and logic were chosen, tradeoffs, and verification limits in the
owner's language; follow the shared review policy's explanation contract.
Before `keel approve <root_run_id>` on a high-risk change, give the owner the High
summary; the full human-understanding contract is in rules.md. Do not ask the owner
to write their own explanation. Normal changes need the entry/flow guide; trivial
changes need a skim.

For a candidate rule violation, open its full section before deciding it. Reuse
existing exact-target test evidence; rerun only when behavior, coverage or evidence
validity requires it. FE, TypeScript and Spring practice references are optional and
apply only to those stacks; they do not add independent blocking rules.
