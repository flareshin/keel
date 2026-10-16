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

Divide the required lenses among independent auditors, one auditor per lens.
Each auditor reads the context needed for its lens and reports only actionable
failures within the requirement. A clean lens needs no verifier. A lens with
findings gets one separate verifier for all of its findings. That verifier
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
the latter batches verification per nonempty lens. Existing snapshot delta and
report provenance contracts remain in force.

Codex uses the version 2 protocol in [codex-review.md](codex-review.md).
It records the completed native child sessions for each lens and any finding
verifiers. Version 1 evidence remains valid under its original two-full-review
contract; use version 2 for new reviews. A version 2 delta must follow a version 2
chain because earlier evidence does not contain per-lens unresolved findings.

Agent-call counts demonstrate batching, not token or latency savings. Measure
actual usage before claiming a reduction in tokens or elapsed time.
