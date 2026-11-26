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

  it("weekly_listsRepoRulesAndAlwaysLoadedBytes_andLeavesExpiryProposalsToPropose", () => {
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
    assert.deepEqual(Object.keys(report).sort(), ["always_loaded", "core_size", "defects", "harness_versions", "recurring_findings", "repo_layer_rules", "review_rounds", "review_tokens"])
    assert.deepEqual(report.repo_layer_rules, { count: 1, ids: ["C-repo"] })
    assert.deepEqual(report.always_loaded, { claude_md: 100, memory_indexes: 50 })
    assert.deepEqual(report.defects, {})
    assert.deepEqual(report.review_rounds, { chains: 0, roots_needing_fixes: 0, chains_by_needs_fixes_rounds: {} })
    assert.deepEqual(report.harness_versions, { recorded: [], observed: {}, unrecorded_newer: [], unversioned: 0 })
    assert.deepEqual(report.recurring_findings, { findings: 0, keys: 0, recurring_keys: 0, top_recurring: [], unkeyed: 0, unparsed: 0, malformed: 0 })
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

  function givenReview(repo: string, evidenceId: string, fields: { rootRunId: string; since?: string; verdict: string; expired?: boolean; transcript?: string }): void {
    box.write(`data/state/keel/evidence/review/${repo.replace("/", "__")}/${evidenceId}.json`, JSON.stringify({
      schema: 1, kind: "review", evidence_id: evidenceId, run_id: fields.since ? `${fields.rootRunId}-${evidenceId}` : fields.rootRunId,
      root_run_id: fields.rootRunId, since: fields.since ?? null, verdict: fields.verdict, paths: [],
      created_at: `${PAST}T08:00:00Z`, expires_at: `${fields.expired ? PAST : FUTURE}T08:00:00Z`,
      ...(fields.transcript === undefined ? {} : { source: { agent_transcript_path: path.join(box.data, fields.transcript) } }),
    }))
  }

  function givenTranscript(relative: string, versions: (string | null)[]): void {
    box.write(relative, versions.map((version) => JSON.stringify(version === null ? { type: "user" } : { type: "assistant", version })).join("\n") + "\n")
  }

  it("weekly_listsObservedHarnessVersionsNewerThanTheNewestRecordedFixture_comparingSegmentsAsNumbers", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    givenTranscript("keel/tests/hooks/fixtures/harness-contract/old.jsonl", ["2.1.99"])
    givenTranscript("keel/tests/hooks/fixtures/harness-contract/new.jsonl", ["2.1.309", "2.1.309"])
    givenTranscript("data/agents/pinned.jsonl", [null, "2.1.309"])
    givenTranscript("data/agents/older.jsonl", ["2.1.100"])
    givenTranscript("data/agents/upgraded.jsonl", ["2.1.309", "2.1.400"])
    givenTranscript("data/agents/bare.jsonl", [null])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "PASS", transcript: "agents/pinned.jsonl" })
    givenReview("acme/app", "b1", { rootRunId: "rv-b", verdict: "PASS", transcript: "agents/older.jsonl" })
    givenReview("acme/lib", "c1", { rootRunId: "rv-c", verdict: "NEEDS_FIXES", transcript: "agents/upgraded.jsonl" })
    givenReview("acme/lib", "c2", { rootRunId: "rv-c", since: "c1", verdict: "PASS", transcript: "agents/upgraded.jsonl" })
    givenReview("acme/lib", "d1", { rootRunId: "rv-d", verdict: "PASS", transcript: "agents/bare.jsonl" })
    givenReview("acme/lib", "e1", { rootRunId: "rv-e", verdict: "PASS", transcript: "agents/gone.jsonl" })
    givenReview("acme/lib", "f1", { rootRunId: "rv-f", verdict: "PASS" })
    givenReview("acme/lib", "g1", { rootRunId: "rv-g", verdict: "PASS", transcript: "agents/expired.jsonl", expired: true })
    givenTranscript("data/agents/expired.jsonl", ["9.9.9"])
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.harness_versions, {
      recorded: ["2.1.99", "2.1.309"],
      observed: { "2.1.100": 1, "2.1.309": 1, "2.1.400": 1 },
      unrecorded_newer: ["2.1.400"],
      unversioned: 2,
    })
  })

  it("weekly_countsATranscriptThatCannotBeReadAsUnversioned_andStillPrintsTheReport", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("data/agents/binary.jsonl", "")
    fs.writeFileSync(path.join(box.data, "agents/binary.jsonl"), Buffer.from([0x7b, 0x7d, 0x0a, 0xff, 0xfe, 0x0a]))
    fs.mkdirSync(path.join(box.data, "agents/folder.jsonl"))
    givenTranscript("data/agents/fine.jsonl", ["2.1.325"])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "PASS", transcript: "agents/binary.jsonl" })
    givenReview("acme/app", "b1", { rootRunId: "rv-b", verdict: "PASS", transcript: "agents/folder.jsonl" })
    givenReview("acme/app", "c1", { rootRunId: "rv-c", verdict: "PASS", transcript: "agents/fine.jsonl" })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.harness_versions, { recorded: [], observed: { "2.1.325": 1 }, unrecorded_newer: ["2.1.325"], unversioned: 2 })
  })

  it("weekly_listsEveryObservedVersionAsUnrecorded_whenNoContractFixtureExists", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    givenTranscript("data/agents/only.jsonl", ["2.1.325"])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "PASS", transcript: "agents/only.jsonl" })
    const [, report] = box.runJson("weekly")
    assert.deepEqual(report.harness_versions, { recorded: [], observed: { "2.1.325": 1 }, unrecorded_newer: ["2.1.325"], unversioned: 0 })
  })

  it("weekly_reportsAnUnreadableReviewAsAHarnessVersionsError", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    box.write("data/state/keel/evidence/review/acme__app/broken.json", "{not json")
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(report.harness_versions.error.startsWith("unreadable evidence "), report.harness_versions.error)
  })

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

  it("weekly_countsARootWithTwoLiveHeadsOnce_byItsNewestChain", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    givenReview("acme/svc", "e1", { rootRunId: "rv-e", verdict: "NEEDS_FIXES" })
    givenReview("acme/svc", "e2", { rootRunId: "rv-e", since: "e1", verdict: "PASS" })
    givenReview("acme/svc", "e3", { rootRunId: "rv-e", since: "e1", verdict: "NEEDS_FIXES" })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.review_rounds, { chains: 1, roots_needing_fixes: 1, chains_by_needs_fixes_rounds: { "2": 1 } })
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

  it("weekly_listsAFindingKeyAsRecurring_onlyWhenTwoDistinctReviewRootsLoggedIt", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    givenFinding({ root_run_id: "rv-1", run_id: "rv-1", path: "hooks/gate.ts", lens: "contract" })
    givenFinding({ root_run_id: "rv-1", run_id: "rv-2", path: "hooks/gate.ts", lens: "contract" })
    givenFinding({ root_run_id: "rv-3", run_id: "rv-3", path: "lib/once.ts", lens: "tests" })
    givenFinding({ root_run_id: "rv-4", run_id: "rv-4", path: "lib/once.ts", lens: "tests" })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.recurring_findings, {
      findings: 4, keys: 2, recurring_keys: 1,
      top_recurring: [{ repo: "acme/app", path: "lib/once.ts", lens: "tests", roots: 2 }],
      unkeyed: 0, unparsed: 0, malformed: 0,
    })
  })

  it("weekly_keysRecurringFindingsByRepoPathAndLens_andOrdersThemByRootCountThenKey", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    for (const root of ["rv-1", "rv-2"]) {
      givenFinding({ root_run_id: root, repo: "acme/web", path: "a.ts", lens: "tests" })
      givenFinding({ root_run_id: root, repo: "acme/app", path: "a.ts", lens: "tests" })
      givenFinding({ root_run_id: root, repo: "acme/app", path: "a.ts", lens: "contract" })
      givenFinding({ root_run_id: root, repo: "acme/web", path: "a.ts", lens: "contract" })
    }
    givenFinding({ root_run_id: "rv-3", repo: "acme/web", path: "a.ts", lens: "tests" })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.recurring_findings.top_recurring, [
      { repo: "acme/web", path: "a.ts", lens: "tests", roots: 3 },
      { repo: "acme/app", path: "a.ts", lens: "contract", roots: 2 },
      { repo: "acme/app", path: "a.ts", lens: "tests", roots: 2 },
      { repo: "acme/web", path: "a.ts", lens: "contract", roots: 2 },
    ])
  })

  it("weekly_countsUnkeyedUnparsedAndMalformedFindingLines_apartFromTheKeys", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    for (const root of ["rv-1", "rv-2"]) {
      givenFinding({ root_run_id: root, path: null })
      givenFinding({ root_run_id: root, path: "N/A" })
      givenFinding({ root_run_id: root, path: "" })
      givenFinding({ root_run_id: root, repo: undefined })
    }
    givenFinding({ root_run_id: 7 })
    givenFinding({ root_run_id: 8 })
    givenFinding({ root_run_id: "rv-3", lens: 7 })
    box.appendLog("keel-findings.jsonl", { ts: "t", evidence_id: "e", repo: "acme/app", root_run_id: "rv-5", run_id: "rv-5", unparsed: true })
    fs.appendFileSync(path.join(box.data, "logs", "keel-findings.jsonl"), "{not json\n")
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.recurring_findings, { findings: 11, keys: 0, recurring_keys: 0, top_recurring: [], unkeyed: 11, unparsed: 1, malformed: 1 })
  })

  it("weekly_listsAtMostTwentyRecurringKeys_andCountsAllOfThem", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    for (let index = 0; index < 21; index++) {
      const file = `f${String(index).padStart(2, "0")}.ts`
      givenFinding({ root_run_id: "rv-1", path: file })
      givenFinding({ root_run_id: "rv-2", path: file })
    }
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(report.recurring_findings.recurring_keys, 21)
    assert.deepEqual(report.recurring_findings.top_recurring.map((key: { path: string }) => key.path),
      Array.from({ length: 20 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`))
  })

  it("weekly_reportsAnUnreadableFindingsLogAsARecurringFindingsError_andStillPrintsTheReport", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    fs.mkdirSync(path.join(box.data, "logs", "keel-findings.jsonl"), { recursive: true })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(report.recurring_findings.error.startsWith("unreadable keel-findings.jsonl: "), report.recurring_findings.error)
    assert.deepEqual(report.review_rounds, { chains: 0, roots_needing_fixes: 0, chains_by_needs_fixes_rounds: {} })
  })

  it("weekly_reportsANonUtf8FindingsLogAsARecurringFindingsError", () => {
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
    fs.mkdirSync(path.join(box.data, "logs"), { recursive: true })
    fs.writeFileSync(path.join(box.data, "logs", "keel-findings.jsonl"), Buffer.from([0x7b, 0x7d, 0x0a, 0xff, 0xfe, 0x0a]))
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(report.recurring_findings.error.startsWith("unreadable keel-findings.jsonl: "), report.recurring_findings.error)
  })

  function givenFinding(fields: Record<string, unknown>): void {
    box.appendLog("keel-findings.jsonl", {
      ts: "2026-11-15T00:00:00Z", evidence_id: "review-x", repo: "acme/app", root_run_id: "rv-0", run_id: "rv-0",
      impact: "high", lens: "contract", finding_id: "C1", path: "x.ts", summary: "s", ...fields,
    })
  }
})
