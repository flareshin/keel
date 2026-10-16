# Native Codex review evidence

Use the same [review policy](review-policy.md) as Claude. The author never reviews
its own output. Required lenses are reuse, contract, tests, readable-code and
rule-checks. One independent auditor may cover all five; split auditors by lens
when risk or scope warrants separate contexts. Findings get a separate verifier;
a clean audit needs none. Coverage is mandatory; five processes are not.

## Workflow

1. Pin the requirement, repository, base commit and candidate snapshot. Run relevant
   tests through `keel test -- <command>`; reuse valid exact-target records rather
   than repeating them in every reviewer. Give reviewers requirements and contracts,
   not author verdicts or the entire author conversation.
2. Spawn a fresh audit child of the author, covering all required lenses, or one
   child per lens. Read the applicable readable-code checklist and only the full
   rule sections needed for the change or a finding. Inspect `git show <tree>:<path>`
   and `git diff <base> <tree>`; do not silently inspect a moving working tree.
3. For each audit with findings, spawn one different verifier child. It checks the
   findings together, including reproductions and relevant callers. It does not
   repeat the full audit. Return one evidenced decision per finding and any new
   actionable failures. Never resume a completed review child.
4. Every child returns exactly the JSON below. Use actual completed session UUIDs:

   ```sh
   "$KEEL_HOME/bin/keel" evidence record-codex --repo /absolute/repository \
     --audits <audit-uuid>
   ```

   Add comma-separated audit UUIDs for split reviews; add `--verifiers <uuid>,<uuid>`
   only for nonempty audits. Missing or overlapping lenses, incomplete findings,
   unrelated children and changed sources refuse registration.
5. Inspect `keel evidence show --repo <repo> --root <returned root_run_id>`.
   Only the owner runs `keel approve <root_run_id>`. Registration is not approval.
   Test, freshness, final blob/mode coverage and owner approval gates still apply.

## Report contract

Persisted reports use format marker `version: 2`. This identifies stored JSON,
not parallel review workflows. The keys below are exact. An auditor's `lenses`
contains one lens or all five, each with status (`complete` or `blocked`) and
concrete evidence. A verifier uses `lenses: {}` and its source audit UUID in
`audit_session`. An unavailable check stays blocked; silence is not success.

```json
{
  "version": 2,
  "role": "audit",
  "repo": "/absolute/repository",
  "base": "<40-hex commit>",
  "tree": "<40-hex snapshot tree>",
  "since_tree": null,
  "root_run_id": null,
  "lenses": {
    "reuse": {"status": "complete", "evidence": "<inspected existing implementations>"},
    "contract": {"status": "complete", "evidence": "<callers and failure boundaries>"},
    "tests": {"status": "complete", "evidence": "<actual runner records and coverage judgment>"},
    "readable-code": {"status": "complete", "evidence": "<applicable rules and inspected code>"},
    "rule-checks": {"status": "complete", "evidence": "<actual scanner summary and signal assessment>"}
  },
  "findings": [],
  "audit_session": null,
  "decisions": []
}
```

Each finding has exactly `id`, `impact` (`high`, `medium`, `low`), `evidence`
(file:line and reproduction/static proof), and `scenario` (trigger, expected,
observed). Combined audits prefix finding IDs with their lens, e.g. `contract:A1`.
Split audits use local IDs. New verifier findings follow the source audit's ID
convention; unresolved IDs within a lens must be unique.

Each decision is exactly `{"id":"contract:A1","verdict":"confirmed|refuted",
"evidence":"<independent proof>"}`. The importer derives NEEDS_FIXES when any
confirmed or new high/medium finding remains, otherwise PASS.

The rule-checks auditor runs `skills/readable-code/scripts/rule-checks.py --repo
<repo> --base <base> --head <tree>` and quotes its exact clean summary once in that
lens's evidence. Other auditors and finding verifiers do not repeat the scan to
fill a report field. The importer reruns it to validate the actual target.

## Deltas

Under the same requirement and base, set `since_tree` to the recorded snapshot and
`root_run_id` to its chain root; all children name those same values and the new
tree. Review `git diff <since_tree> <tree>` and affected contracts. Each required
lens still runs, possibly in one context.

The audit's decisions settle every previously unresolved finding with evidence:
refuted means resolved, confirmed means still present. A combined audit uses
`<lens>:<previous-id>` for each prior local finding, including findings from split
reviews; a split audit uses that lens's local IDs. Existing high/medium findings
still block outside the delta. New findings get separate verification.

New deltas follow the current chain head. Revalidation follows the exact stored
parent evidence ID. Complete reviewer identity sets bind run IDs. Changed
requirements/bases, invalid evidence or unbounded scope require a full review.
The mechanical scanner still uses the original base and final tree, as in Claude.

## Storage and retirement

New registrations use only the current flow; the old `--audit/--verify` writer is
removed. Existing old-format records remain read-only under their original source
validation, so already approved chains stay usable. No old workflow instructions
need to be loaded for new reviews. The compatibility decoder is removed once
`keel evidence compatibility` reports no unexpired old-format records or chain
references across all repositories. Never relabel or rewrite historical evidence.
A delta cannot start from a record that lacks per-lens unresolved findings.

## Runtime boundary

The importer reads the OS account's default local Codex sessions, independent of
HOME/CODEX_HOME overrides. It requires distinct real child sessions with matching
parent IDs, task_started, assistant final_answer and task_complete records.
Unfinished/aborted, archived, moved, custom-profile or ambiguous records refuse
registration. The observed local JSONL layout is an implementation dependency,
not a stable public API. Source hashes are revalidated on approval and shipping.

Keep session/evidence guards enabled and trust hook definitions through the normal
owner flow. This is a local workflow integrity boundary, not an arbitrary-program
sandbox. Never manufacture provenance, session UUIDs or approval records.
