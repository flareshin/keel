# Implementation through the caller

Writing guidance under K3 and K5 for non-trivial behavior changes. Use the
project's language and existing patterns; a simple local edit needs no design
ceremony. This is shared by Claude and Codex through `readable-code`, not an
additional workflow or review lens.

## Start with the call

Before filling in a new interface, write one realistic caller usage or test:
inputs, observable result, failure behavior, and any ordering or side effects.
Use actual stored and wire formats when those are the contract. A usage sketch
belongs in a test or the reading guide, not a committed unimplemented scaffold.
Do not invent a new interface when an existing one fits.

Choose the smallest public surface that lets callers do their job without
repeating domain decisions. Put each business rule with its owner, rather than
making callers learn a chain of helper objects. A module earns its place when
removing it would duplicate real complexity in its callers; a forwarding layer
that only moves complexity usually does not. Reuse the vocabulary in
[improve](../../improve/SKILL.md#vocabulary) when discussing module depth; this
reference does not authorize a scan or cleanup outside the requested diff.

An interface or adapter is justified by a real boundary, variation, test need,
or established framework convention. A second implementation is useful evidence,
not a prerequisite. Keep transactions, permission checks and external I/O
explicit; a small public surface does not justify a giant method or hidden
side effects. Data access and persistence assertions are valid test surfaces
when persisted behavior is part of the requirement.

## Build one observable behavior

Split by a complete behavior a caller can exercise, not by all repositories,
then all services, then all screens. For example, connect adding one allowed
member through save and reload before expanding to duplicate and forbidden-member
cases. Preserve existing permission and consistency invariants in that first
slice; an incomplete authorization path is not a useful increment.

For each slice:

1. State the expected result and the boundary the test observes. Infer routine
   test placement from the repo; ask only when competing choices change scope
   or the contract. Do not add a per-test owner checkpoint.
2. For a behavior bug, run the reproduction red before fixing it (K3). For new
   logic, write a meaningful failing test first when the existing test seam
   permits it. For structural changes, pin current behavior before and after.
   A compile failure from a missing symbol alone does not reproduce a bug.
3. Add only the implementation needed for that behavior, and run the relevant
   command through `keel test -- <cmd>`. Choose the repository's test tools and
   reuse still-valid evidence; do not rerun unchanged checks for reassurance.
4. Extend to the next behavior once the prior slice is verified. Run the final
   integration checks needed for the combined path, including real boundaries
   that mocks do not cover. Report unavailable checks as limits, not passes.

When producers and consumers live in different repos, pin their shared contract
first. A mock can unblock local work; it cannot prove the real integration or
mixed-version rollout. Preserve the repo's deployment order and compatibility
window. A feature flag does not make a data change reversible or lower its risk.

## Reconsider the shape when evidence changes

If callers repeatedly need internal knowledge, new parameters carry the same
workaround, or type escapes hide an invalid state, revisit the owning interface
before adding another patch. Compare alternatives when they change ownership,
compatibility, or testability; a routine edit does not require multiple agents
or models. Use `prompt-refine` only for unresolved choices that change the work.

Keep verification local to each slice and review the ready candidate once under
[review policy](../../../docs/review-policy.md). Neither a green slice nor a
completed sketch authorizes a commit, PR, merge, deployment, or notification;
follow the current owner's authorization and the normal delivery gates.
Explain the caller, flow, chosen boundary and verified behavior in the reading
guide. Do not enforce a line quota or commit after every slice automatically.

## Sources and adaptation

Design ideas informed by [Matt Pocock's codebase-design](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md),
[Addy Osmani's incremental-implementation](https://github.com/addyosmani/agent-skills/blob/main/skills/incremental-implementation/SKILL.md),
and [pstack architect](https://github.com/cursor/plugins/blob/main/pstack/skills/architect/SKILL.md),
read on 2026-10-19. This guidance is written for keel: no mandatory terminology
replacement, fixed model panel, test-boundary approval loop, auto-commit, or
broken scaffold is imported. Shared rules remain in K3, K5 and the review policy.
