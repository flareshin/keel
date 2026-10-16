# Native Codex review evidence

Native review uses two fresh Codex child agents in the author's current chat: an audit and a verifier. It does not invoke Claude, execute Workflow JavaScript or translate a Codex report into Claude provenance. `codex-lens-review` is a separate review kind accepted by the same tests, content-coverage and owner-approval gates.

## Prerequisites and trust boundary

Install the Codex adapter with protection of the actual OS user's `~/.codex/sessions/` and `archived_sessions/` from agent tool writes, removals and moves. Keep the shared evidence-store guards enabled. Review and trust the hook definition through the owner's normal Codex hook-trust flow. This is a local workflow integrity boundary, not cryptographic attestation or protection against arbitrary same-user programs outside hook coverage.

Version 1 reads the local JSONL rollout layout observed in Codex Desktop on 2026-10-16. It requires `session_meta.source.subagent.thread_spawn`, a matching `parent_thread_id`, `task_started`, an assistant `final_answer`, and matching `task_complete`. It fails closed on absent, ambiguous, malformed, aborted or unfinished records. Paginated-only storage, custom profiles, archived/moved records and other runtime layouts are unsupported. No environment override selects a different source directory: the importer resolves the OS account home independently of `HOME` and `CODEX_HOME`.

## Workflow

1. Run the relevant tests with `keel test -- <command>`. Snapshot the candidate with `keel snapshot <repo>`. Resolve the review base to a commit SHA. Give each reviewer the exact base/tree and instruct it to use `git show <tree>:<path>` and `git diff <base> <tree>`.
2. Spawn a fresh audit child from the author chat. Pass the user requirement, not author verdicts or asserted test success. It must inspect reuse, contracts/callers, test obligations, readable-code rules and the actual rule-checks output. Static findings need file:line evidence and a concrete failure scenario. Load the applicable public skills and private overlay review lenses. A regex scan with no signals is not complete semantic review.
3. After that child completes, spawn a different fresh verifier child from the same author chat. Pass the audit session UUID and findings. The verifier independently checks all five lenses and settles every audit finding as confirmed or refuted with evidence; it may add its own findings. Any unavailable lens stays blocked. Do not ask a reviewer to rubber-stamp a desired verdict.
4. Each child's final response must be exactly one JSON object in the shape below, without Markdown fences or surrounding prose. Use a dedicated child for the review; resuming it later changes the provenance and requires another review. Read the child UUID from Codex's actual session metadata, not from a nickname or invented identifier.
5. Register from the author chat using the installed CLI:

```sh
KEEL_HOME="$HOME/git/keel" \
KEEL_OVERLAY_DIR="$HOME/git/keel-overlay" \
KEEL_DATA_DIR="$HOME/.claude" \
"$HOME/git/keel/bin/keel" evidence record-codex \
  --repo /absolute/repository \
  --audit <audit-session-uuid> \
  --verify <verifier-session-uuid>
```

The command takes session IDs, never a report file or caller-supplied verdict. It locates real session records, validates their relationship and reports, checks the candidate snapshot is unchanged and recomputes reviewed paths from Git. It runs rule-checks itself against that exact base/tree and requires both reviewers to quote its exact summary once in their rule-checks evidence (plain text, no trailing punctuation). Failed scans, zero recognized repositories and unscanned targets refuse registration. It derives `PASS` only when no confirmed or newly found high/medium finding remains. A blocked lens or missing adjudication produces no record. A repeated identical registration is idempotent.

6. Read `keel evidence show --repo <repo> --root <returned root_run_id>` to confirm registration. A `NEEDS_FIXES` review cannot be approved. After a fix, run tests and two new reviewers over the complete candidate; v1 does not support native delta chains.
7. Explain the change and verification limits to the owner. Only the owner runs `keel approve <root_run_id>` in their terminal. A chat PASS or `--read` acknowledgement does not approve. The approval and ship gate re-read the review sources and hashes; missing or changed provenance refuses use. The ship gate still verifies exact blobs/modes, tests, test-path obligations and approval binding. Registration does not commit, push, merge or install anything.

## Final report shape

This is a shape illustration, not review evidence. Replace values with facts obtained during review. `lenses` must contain exactly the five keys shown, each with `status` (`complete` or `blocked`) and concrete `evidence`. Both report roles use every field. `repo` is the canonical repository root; `base` is a commit; `tree` is the exact snapshot tree. Evidence must cite inspected code, actual command output or test results, not the author's explanation or code comments alone.

```json
{
  "version": 1,
  "role": "audit",
  "repo": "/absolute/repository",
  "base": "<40-hex commit>",
  "tree": "<40-hex tree>",
  "lenses": {
    "reuse": {"status": "complete", "evidence": "<search and inspected locations>"},
    "contract": {"status": "complete", "evidence": "<caller and contract analysis>"},
    "tests": {"status": "complete", "evidence": "<test counts/output and regression adequacy>"},
    "readable-code": {"status": "complete", "evidence": "<rule and inspected locations>"},
    "rule-checks": {"status": "complete", "evidence": "<actual summary and signal assessment>"}
  },
  "findings": [],
  "audit_session": null,
  "decisions": []
}
```

A finding has exactly `id`, `impact` (`high`, `medium`, `low`), `evidence` (file:line and reproduction or static proof) and `scenario` (trigger, expected, observed). IDs are unique within a report. The verifier uses `role: "verify"`, sets `audit_session` to the audit child's actual UUID, and adds exactly one decision per audit finding: `{"id":"A1","verdict":"confirmed|refuted","evidence":"<independent proof>"}`. Its `findings` contains newly discovered failures, not copies of the audit findings. The importer derives the verdict, so neither report has a `verdict` field.

## Reading guide

Entry point: `lib/evidence/cli.py:_evidence` → `codex_review.register`.
Flow: resolve real rollout → completed report → distinct children → same target and five lenses → settle findings → unchanged snapshot → native evidence.
Changed: native source type and review kind; approval/gate revalidation for native evidence.
Unchanged: Claude writers and provenance, evidence TTL, test obligations, exact coverage, owner approval.
Decisions: use existing Codex child records; reject arbitrary JSON import and environment-selected roots.
Rejected: treating a single PASS message as a multi-lens review, or fabricating Claude handback records.
Read first: `completed_report`, `shared_author`, `validate_reports`, `validate_evidence`.

Official interfaces: [Codex app-server review](https://learn.chatgpt.com/docs/app-server#review) supports separate review contexts; [non-interactive output](https://learn.chatgpt.com/docs/non-interactive-mode) documents structured execution surfaces. The local rollout format used here is verified against the installed runtime, not claimed as a stable public API.
