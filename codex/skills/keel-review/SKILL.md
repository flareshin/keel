---
name: keel-review
description: Review a keel-governed code change in a fresh Codex reviewer context before delivery, with concrete failure scenarios and verification evidence.
---

# Keel review

Determine the repository, review base, requested behavior, and changed files. Read the applicable repository instructions, `readable-code`, and any project-specific review skills supplied by the private overlay.

For an ordinary independent review, use a fresh reviewer agent or the dedicated code-review tool if available. Give it the original request, exact diff/base, relevant contracts, and the reading guide, without author verdicts or claims that the change is correct. If neither is available, use a separate `codex review` invocation with the appropriate base or uncommitted scope after checking its help. If no independent context can run, report the review as unavailable.

Ask the reviewer to identify only actionable failures in scope. Findings need file and line evidence, triggering input, expected and observed behavior, and a runnable reproduction or a concrete static caller/contract analysis. Check tests can detect the changed behavior; zero recognized tests is not a pass.

Return the independent verdict, findings, reviewed tree/base and actual test output. After fixes, use a fresh independent delta review of the changed lines, affected contracts and prior findings. Review the tested final candidate once; a formal review already supplies the independent review, so do not run an extra ordinary review over the same snapshot. Do not generate Claude transcript provenance, `KEEL-EVIDENCE`, approval records, or a claim that this report satisfies ship-gate. A standalone review report does not satisfy ship-gate.

## Formal native evidence

First check whether the installed keel CLI supports `evidence record-codex --audits` and
whether `docs/codex-review.md` exists under KEEL_HOME. If either is absent, report
formal registration as unavailable; never synthesize an evidence record.

Read that document before spawning reviewers. It owns the report schema and
registration contract. Follow `docs/review-policy.md`: spawn one independent child
per required lens over the same exact Git base and snapshot. Spawn one different
verifier for each lens with findings, batching that lens's findings. Clean lenses
need no verifier. Verifiers settle findings instead of repeating the full audit.
Each child returns exactly the documented version 2 JSON as its final answer;
unavailable checks stay blocked. Do not resume completed review children.

Register their actual session UUIDs with `keel evidence record-codex --repo <root>
--audits <comma-separated-audit-uuids>` and `--verifiers <comma-separated-verifier-uuids>`
only when findings exist. Inspect the resulting evidence. Native evidence supports
the OS user's default local sessions only; custom profiles and archived records
are unsupported. After a code fix, rerun relevant tests and review the delta from
the recorded version 2 snapshot, settling every prior unresolved finding with
evidence. A changed requirement or base needs a new full review. Legacy version 1
records keep their original rules. Trusted session/evidence guards
are prerequisites, not proof of a sandbox. Never modify source rollout records.

Explain the result and remaining limits to the owner. Only the owner runs
`keel approve <root_run_id>`. Registration alone neither approves nor ships the
change; tests, content coverage and approval gates still apply.
