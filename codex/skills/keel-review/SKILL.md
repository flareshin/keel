---
name: keel-review
description: Review a keel-governed code change in a fresh Codex reviewer context before delivery, with concrete failure scenarios and verification evidence.
---

# Keel review

Determine the repository, review base, requested behavior, and changed files. Read the applicable repository instructions, `readable-code`, and any project-specific review skills supplied by the private overlay.

For an ordinary independent review, use a fresh reviewer agent or the dedicated code-review tool if available. Give it the original request, exact diff/base, relevant contracts, and the reading guide, without author verdicts or claims that the change is correct. If neither is available, use a separate `codex review` invocation with the appropriate base or uncommitted scope after checking its help. If no independent context can run, report the review as unavailable.

Ask the reviewer to identify only actionable failures in scope. Findings need file and line evidence, triggering input, expected and observed behavior, and a runnable reproduction or a concrete static caller/contract analysis. Check tests can detect the changed behavior; zero recognized tests is not a pass.

Return the independent verdict, findings, reviewed tree/base and actual test output. After fixes, obtain a fresh review of the updated change. Do not generate Claude transcript provenance, `KEEL-EVIDENCE`, approval records, or a claim that this report satisfies ship-gate. A standalone review report does not satisfy ship-gate.

## Formal native evidence

First check whether the installed keel CLI supports `evidence record-codex` and
whether `docs/codex-review.md` exists under KEEL_HOME. If either is absent, report
formal registration as unavailable; never synthesize an evidence record.

Read that document before spawning reviewers. It owns the report schema and
registration contract. Use two fresh child agents of the author chat: an audit,
then a different verifier. Both inspect the same exact Git base and snapshot tree
through all five required lenses. The verifier independently adjudicates every
audit finding. Each child returns exactly the documented JSON as its final answer;
unavailable checks stay blocked. Do not resume completed review children.

Register their actual session UUIDs with `keel evidence record-codex --repo <root>
--audit <audit-uuid> --verify <verify-uuid>` and inspect the resulting evidence.
Version 1 supports the OS user's default local sessions only; custom profiles,
archived records and native delta chains are unsupported. A code fix requires
new tests and two new full-candidate reviewers. Trusted session/evidence guards
are prerequisites, not proof of a sandbox. Never modify source rollout records.

Explain the result and remaining limits to the owner. Only the owner runs
`keel approve <root_run_id>`. Registration alone neither approves nor ships the
change; tests, content coverage and approval gates still apply.
