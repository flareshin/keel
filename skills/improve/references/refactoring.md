# Refactoring without changing behavior

Use this procedure for the selected change from `improve`, whether the user
selected a candidate report or requested the structural change directly.

## Establish the contract before moving structure

Trace a real caller through inputs, outputs, errors and side effects. Include
observable ordering, persistence, authorization and serialization where the change
touches them. Name the target shape and the concrete reading friction it removes:
for example, a caller no longer crosses a forwarding layer, or one module owns a
decision that callers previously repeated. Keep a clear local implementation when
an added abstraction would only hide the flow.

Choose a behavior pin at a boundary both versions expose: characterization tests,
a reviewed snapshot, or an old/new comparison harness. Existing tests count when
they cover that boundary. Expected values come from the requirement or recorded
behavior, not from a second copy of the implementation. When internal signatures
change, test through a stable caller or adapt both versions to the same harness.
An unimplemented new API cannot supply the before result. Typecheck, lint and
code-size counts do not establish behavior equivalence.

Run the pin against the unchanged implementation through `keel test -- <cmd>` and
record the runner summary and exit code before the first structural edit. Cover
normal inputs and the edge cases affected by the move. A bug found here becomes a
separate red-test fix; preserve its current observable behavior in this refactoring
unless the user explicitly changes the task to a behavior change.

## Change one verifiable unit

Read the history before removing a guard, layer or API; a reason that still holds
is a constraint on the design. Subtract redundant structure before adding the new
shape, and keep the pin green after each small step. A passing test suite is a
checkpoint, not authorization to make a commit.

Inventory callers before changing an interface. Include reflection, configuration,
string names, tests and documentation as well as static imports. If every caller
is in the owned change, migrate them and remove the old interface in that same
change. For independently deployed services, shipped clients or persisted formats,
keep the staged compatibility path from `improve` step 4; list the consumers and
the evidence needed before removing it. Do not import a blanket ban on shims
across an external boundary.

If a pin fails, stop the structural move and identify the input and observable
mismatch. Restore only the changes from this attempt to the last verified state;
never discard another task's work. Split the move smaller or revise the shape.
An uncovered behavior is a verification limit, not an equivalence claim.

## Prove the result and decide whether to keep it

Run the same pin after the change through `keel test -- <cmd>` and run the
relevant existing tests. For a larger reshape, replay a fixed baseline against
both versions or compare their outputs and side effects on the same inputs.
Report recognized cases and mismatches, including ordering and error differences;
a zero-case run proves nothing. Test the actual changed contract rather than
substituting compilation or a fixture for a live integration claim.

Show one concrete before/after caller trace or decision-ownership comparison.
Fewer lines alone are not a readability result. If the new structure leaves the
reading friction unchanged or adds indirection, revise it or drop only this
attempt. Report what changed, the before/after pin, equivalence limits, callers
migrated, compatibility still required and the reading improvement.

Use the existing independent review and owner delivery gates. In Codex, load
`keel-review`; the shared `/lens-review` name is not a Codex API. No automatic PR,
commit, model fan-out or runtime activation is part of this procedure.

## Source and adaptation

Adapted from pstack's [Refactoring playbook](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/refactoring.md),
read on 2026-10-25, alongside the sources already credited in `improve`.
The upstream material is MIT licensed in `cursor/plugins/pstack/LICENSE`.
This adaptation keeps keel's staged external-consumer migrations, test evidence,
author/reviewer separation and owner approval boundaries. It adds no new ledger
rule; the procedure applies existing K1–K5 obligations to structural changes.
