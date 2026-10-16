---
name: keel-review
description: Review a keel-governed code change in a fresh Codex reviewer context before delivery, with concrete failure scenarios and verification evidence.
---

# Keel review

Determine the repository, review base, requested behavior, and changed files. Read the applicable repository instructions, `readable-code`, and any project-specific review skills supplied by the private overlay.

Use a fresh reviewer agent or the dedicated code-review tool if available. Give it the original request, exact diff/base, relevant contracts, and the reading guide, without author verdicts or claims that the change is correct. If neither is available, use a separate `codex review` invocation with the appropriate base or uncommitted scope after checking its help. If no independent context can run, report the review as unavailable.

Ask the reviewer to identify only actionable failures in scope. Findings need file and line evidence, triggering input, expected and observed behavior, and a runnable reproduction or a concrete static caller/contract analysis. Check tests can detect the changed behavior; zero recognized tests is not a pass.

Return the independent verdict, findings, reviewed tree/base and actual test output. After fixes, obtain a fresh review of the updated change. Do not generate Claude transcript provenance, `KEEL-EVIDENCE`, approval records, or a claim that this report satisfies ship-gate. The existing ship-gate requires its own supported evidence chain.
