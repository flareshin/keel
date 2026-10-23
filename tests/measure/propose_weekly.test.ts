import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import path from "node:path"

import { addDays } from "../../measure/lib/measurekit/dates.ts"
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
    assert.deepEqual(Object.keys(report).sort(), ["always_loaded", "core_size", "defects", "proposals", "repo_layer_rules"])
    assert.deepEqual(report.repo_layer_rules, { count: 1, ids: ["C-repo"] })
    assert.deepEqual(report.always_loaded, { claude_md: 100, memory_indexes: 50 })
    assert.deepEqual(report.proposals.map((p: { id: string; action: string }) => [p.id, p.action]), [["C-late", "demote"]])
    assert.deepEqual(report.defects, {})
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
})
