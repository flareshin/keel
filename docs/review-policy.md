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

## Fixes and later changes

Use a delta from the recorded snapshot under the same requirement and base.
Review the changed lines and affected contracts, reading surrounding unchanged
code when needed. Include every unresolved prior finding in the brief and settle
each with evidence. An unresolved blocking finding still blocks even if its
line is outside the delta. Keep final candidate tests and coverage checks.

Start a full review when the requirement or review base changes, prior evidence
is missing or invalid, or the new scope cannot be assessed as a bounded delta.
Do not restart the entire review merely because a small fix was made.

## Runtime contracts

Claude uses `workflows/lens-review.js` and `workflows/adversarial-audit.js`;
the latter batches verification per source audit with findings. Existing snapshot delta and
report provenance contracts remain in force.

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
