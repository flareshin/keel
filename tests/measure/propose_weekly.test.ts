import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { addDays } from "../../measure/lib/measurekit/dates.ts"
import { MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts"
import { FUTURE, PAST, TODAY, MeasureSandbox, charterRow, ledgerRow } from "./helpers.ts"

const EXTENDED = addDays(TODAY, 60)

describe("propose", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
  })
  afterEach(() => box.cleanup())

  function propose(...args: string[]): any[] {
    const [completed, result] = box.runJson("propose", args)
    assert.equal(completed.status, 0, completed.stderr)
    return result.proposals
  }

  it("propose_demotesOneLayer_whenExpiredRowCountsZero", () => {
    box.writeLedger("keel/ledger.tsv", [
      ledgerRow("C-hook", { review_by: PAST }),
      ledgerRow("C-skill", { review_by: PAST, layer: "skill", enforced_at: "skill:demo", why_not_stronger: "Judgment." }),
      ledgerRow("C-prose", { review_by: PAST, layer: "prose", enforced_at: "prose:PRINCIPLES.md", why_not_stronger: "Judgment." }),
    ])
    const proposals = propose()
    assert.deepEqual(proposals.map((p) => [p.id, p.action, p.from, p.to]), [
      ["C-hook", "demote", "hook", "skill"],
      ["C-skill", "demote", "skill", "prose"],
      ["C-prose", "retire", "prose", "retired"],
    ])
  })

  it("propose_extendsReviewBySixtyDays_whenExpiredRowStillCounts", () => {
    box.writeLedger("keel/ledger.tsv", [ledgerRow("C-demo", { review_by: PAST })])
    box.fire("C-demo")
    assert.deepEqual(propose(), [{ id: "C-demo", action: "extend", from: PAST, to: EXTENDED, reason: "metric counted 1 item(s) in the window" }])
  })

  it("propose_rechecksRepoRow_whenExistenceCheckFails", () => {
    const missing = path.join(box.root, "nowhere")
    box.writeLedger("keel/ledger.tsv", [
      ledgerRow("C-repo", { layer: "repo", enforced_at: "repo:acme/app:lint.cfg", metric: `exists:${missing}:HEAD:lint.cfg`, review_by: PAST }),
    ])
    assert.deepEqual(propose().map((p) => [p.action, p.from, p.to]), [["recheck", "repo", "repo"]])
  })

  it("propose_rechecksInsteadOfDemoting_whenTheMetricRunnerFails", () => {
    box.writeLedger("keel/ledger.tsv", [ledgerRow("C-demo", { review_by: PAST, metric: "run:crashes" })])
    box.write("keel/measure/metrics/crashes", "#!/bin/bash\necho boom >&2\nexit 3\n", true)
    const proposals = propose()
    assert.deepEqual(proposals.map((p) => [p.id, p.action, p.from, p.to]), [["C-demo", "recheck", "hook", "hook"]])
    assert.equal(proposals[0].reason, "metric errored, nothing counted: runner crashes exited 3: boom")
  })

  it("propose_ignoresRowsNotYetExpiredAndCharterRows", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1"), ledgerRow("C-fresh", { review_by: FUTURE }), ledgerRow("C-done", { review_by: PAST, status: "retired" })])
    assert.deepEqual(propose(), [])
  })

  it("propose_emitsOneRereviewPerActiveRow_onModelUpgrade", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1"), ledgerRow("C-demo"), ledgerRow("C-done", { status: "retired" })])
    const proposals = propose("--model-upgrade", "model-next")
    assert.deepEqual(proposals.map((p) => [p.id, p.action]), [["K1", "rereview"], ["C-demo", "rereview"]])
    assert.ok(proposals[0].reason.includes("model-next"))
  })
})

describe("weekly", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
    box.initRepo(box.keel)
  })
  afterEach(() => box.cleanup())

  it("weekly_listsRepoRulesProposalsAndAlwaysLoadedBytes", () => {
    box.writeLedger("keel/ledger.tsv", [
      charterRow("K1"),
      ledgerRow("C-late", { review_by: PAST, grace_until: FUTURE }),
      ledgerRow("C-repo", { layer: "repo", enforced_at: "repo:acme/app:lint.cfg", metric: "exists:/nowhere:HEAD:lint.cfg" }),
    ])
    box.write("data/CLAUDE.md", "x".repeat(100))
    box.write("data/projects/a/memory/MEMORY.md", "y".repeat(30))
    box.write("data/projects/b/memory/MEMORY.md", "z".repeat(20))
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(Object.keys(report).sort(), ["always_loaded", "core_size", "defects", "proposals", "repo_layer_rules", "review_rounds"])
    assert.deepEqual(report.repo_layer_rules, { count: 1, ids: ["C-repo"] })
    assert.deepEqual(report.always_loaded, { claude_md: 100, memory_indexes: 50 })
    assert.deepEqual(report.proposals.map((p: { id: string; action: string }) => [p.id, p.action]), [["C-late", "demote"]])
    assert.deepEqual(report.defects, {})
    assert.deepEqual(report.review_rounds, { chains: 0, roots_needing_fixes: 0, chains_by_needs_fixes_rounds: {} })
  })

  it("weekly_reportsCoreNonTestLocAndDesignBytes_fromTrackedFiles", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("keel/lib/tool.py", "a = 1\nb = 2\n")
    box.write("keel/bin/tool", "#!/bin/sh\necho\necho\n", true)
    box.write("keel/tests/test_tool.py", "x = 1\n".repeat(50))
    box.write("keel/skills/demo/SKILL.md", "line\n".repeat(9))
    box.write("keel/docs/DESIGN.md", "d".repeat(120))
    box.commitAll(box.keel)
    box.write("keel/lib/untracked.py", "c = 3\n")
    const [, report] = box.runJson("weekly")
    assert.deepEqual(report.core_size, { non_test_loc: 5, design_md_bytes: 120 })
  })

  it("weekly_countsTypeScriptSource_andSkipsEveryTestsDirectory", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("keel/hooks/gate.ts", "a\nb\nc\n")
    box.write("keel/codex/tests/case.ts", "x\n".repeat(40))
    box.write("keel/tests/hooks/gate.test.ts", "y\n".repeat(30))
    box.commitAll(box.keel)
    const [, report] = box.runJson("weekly")
    assert.equal(report.core_size.non_test_loc, 3)
  })

  it("weekly_skipsTestFilesOutsideTestsDirectories", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("keel/hooks/gate.ts", "a\nb\nc\n")
    box.write("keel/hooks/gate.test.ts", "y\n".repeat(30))
    box.write("keel/lib/parse.spec.ts", "z\n".repeat(20))
    box.commitAll(box.keel)
    const [, report] = box.runJson("weekly")
    assert.equal(report.core_size.non_test_loc, 3)
  })

  it("weekly_reportsOverlayDefectRunners_andTheirErrors", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("overlay/measure/metrics/defects-reverts", '#!/bin/bash\necho \'{"count": 1, "items": ["abc"]}\'\n', true)
    box.write("overlay/measure/metrics/defects-broken", "#!/bin/bash\nexit 3\n", true)
    box.write("overlay/measure/metrics/other", "#!/bin/bash\necho ignored\n", true)
    const [, report] = box.runJson("weekly")
    assert.deepEqual(report.defects["defects-reverts"], { count: 1, items: ["abc"] })
    assert.ok(report.defects["defects-broken"].error.includes("exited 3"))
    assert.ok(!("other" in report.defects))
  })

  function givenReview(repo: string, evidenceId: string, fields: { rootRunId: string; since?: string; verdict: string; expired?: boolean }): void {
    box.write(`data/state/keel/evidence/review/${repo.replace("/", "__")}/${evidenceId}.json`, JSON.stringify({
      schema: 1, kind: "review", evidence_id: evidenceId, run_id: fields.since ? `${fields.rootRunId}-${evidenceId}` : fields.rootRunId,
      root_run_id: fields.rootRunId, since: fields.since ?? null, verdict: fields.verdict, paths: [],
      created_at: `${PAST}T08:00:00Z`, expires_at: `${fields.expired ? PAST : FUTURE}T08:00:00Z`,
    }))
  }

  it("weekly_countsNeedsFixesRoundsPerLiveReviewChain", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "NEEDS_FIXES" })
    givenReview("acme/app", "a2", { rootRunId: "rv-a", since: "a1", verdict: "NEEDS_FIXES" })
    givenReview("acme/app", "a3", { rootRunId: "rv-a", since: "a2", verdict: "PASS" })
    givenReview("acme/app", "b1", { rootRunId: "rv-b", verdict: "PASS" })
    givenReview("acme/lib", "c1", { rootRunId: "rv-c", verdict: "NEEDS_FIXES" })
    givenReview("acme/lib", "c2", { rootRunId: "rv-c", since: "c1", verdict: "PASS" })
    givenReview("acme/lib", "d1", { rootRunId: "rv-d", verdict: "NEEDS_FIXES", expired: true })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.review_rounds, { chains: 3, roots_needing_fixes: 2, chains_by_needs_fixes_rounds: { "0": 1, "1": 1, "2": 1 } })
  })

  it("weekly_reportsAnUnreadableReviewAsAReviewRoundsError_andStillReportsTheRest", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("data/state/keel/evidence/review/acme__app/broken.json", "{not json")
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(report.review_rounds.error.startsWith("unreadable evidence "), report.review_rounds.error)
    assert.deepEqual(report.defects, {})
  })

  it("weekly_reportsAReviewNestedPastTheJsonDepthLimitAsAReviewRoundsError", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    const depth = MAX_JSON_DEPTH + 1
    box.write("data/state/keel/evidence/review/acme__app/deep.json", "[".repeat(depth) + "]".repeat(depth))
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(report.review_rounds.error.includes(`deeper than ${MAX_JSON_DEPTH} levels`), report.review_rounds.error)
  })

  it("weekly_fails_whenTheReviewEvidenceDirectoryCannotBeListed", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("data/state/keel/evidence/review/acme__app/a1.json", "{}")
    const repoDir = path.join(box.data, "state/keel/evidence/review/acme__app")
    fs.chmodSync(repoDir, 0o000)
    try {
      const completed = box.runMeasure("weekly")
      assert.notEqual(completed.status, 0)
    } finally {
      fs.chmodSync(repoDir, 0o700)
    }
  })
})
