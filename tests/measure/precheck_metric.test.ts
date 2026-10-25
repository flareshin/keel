import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import path from "node:path"

import { addDays } from "../../measure/lib/measurekit/dates.ts"
import { isExecutable } from "../../measure/lib/measurekit/files.ts"
import { CHECKOUT, FUTURE, MeasureSandbox, NOW_TS, TODAY, ledgerRow } from "./helpers.ts"

const RUNNER = "measure/metrics/C-precheck"
const TREE = "1".repeat(40)
const OTHER_TREE = "2".repeat(40)
const THREE_SOURCES = ["lib/a.ts", "lib/b.ts", "hooks/c.mjs", "tests/a.test.ts", "docs/a.md"]

const NEEDS_FIXES_REPORT = [
  "VERDICT: NEEDS_FIXES",
  "",
  "Merge-blocking (3):",
  "- [high] tests/T1: Deleting the guard in lib/a.ts keeps every test green.",
  "  At: lib/a.ts:3",
  "- [medium] tests/T2: The new branch has no test at all.",
  "- [medium] contract/C1: The caller in hooks/c.mjs still reads the old key; removing that read keeps every test green.",
  "",
  "Non-blocking:",
  "- [low] tests/T3: Reverting the rename would still pass.",
  "",
  "Pre-existing:",
  "- [medium] tests/P1: Removing the old fallback still passes.",
  "",
  "KEEL-EVIDENCE: {}",
].join("\n")

interface ReviewFields {
  runId: string
  rootRunId?: string
  repo?: string
  since?: string | null
  createdAt?: string
  verdict?: string
  paths?: string[]
  tree?: string
  transcript?: string | null
}

describe("C-precheck runner", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
    box.linkShippedRunners()
    box.writeLedger("keel/ledger.tsv", [ledgerRow("C-precheck", { metric: "run:C-precheck", grace_until: FUTURE })])
  })
  afterEach(() => box.cleanup())

  const givenReview = (fields: ReviewFields): void => {
    const repo = fields.repo ?? "flareshin/keel"
    box.write(`data/state/keel/evidence/review/${repo.replace("/", "__")}/${fields.runId}-${repo.replace("/", "_")}.json`, JSON.stringify({
      run_id: fields.runId,
      root_run_id: fields.rootRunId ?? fields.runId,
      repo,
      since: fields.since ?? null,
      created_at: fields.createdAt ?? NOW_TS,
      verdict: fields.verdict ?? "PASS",
      snapshot_tree: fields.tree ?? TREE,
      paths: (fields.paths ?? THREE_SOURCES).map((changed) => ({ path: changed, blob: "0".repeat(40), mode: "100644" })),
      source: { agent_transcript_path: fields.transcript ?? null },
    }))
  }

  const givenPrecheck = (tree: string = TREE): void => {
    box.appendLog("keel-precheck.jsonl", { at: NOW_TS, repo: "/somewhere/keel", review_base: "0".repeat(40), tree, outcome: "census" })
  }

  const givenReport = (text: string): string => {
    const assistant = { message: { role: "assistant", content: [{ type: "text", text }] } }
    const earlier = { message: { role: "assistant", content: [{ type: "text", text: "Merge-blocking (9): - [high] tests/X: draft still pass" }] } }
    return box.write("data/transcripts/reporter.jsonl", [earlier, { message: { role: "user", content: "next" } }, assistant].map((line) => JSON.stringify(line)).join("\n") + "\n")
  }

  const runMetric = () => {
    const [completed, result] = box.runJson("run", ["C-precheck"])
    assert.ok(completed.status === 0 || completed.status === 1, completed.stderr)
    return result
  }

  it("runnerInThisCheckout_isExecutable_soFindRunnerResolvesIt", () => {
    assert.ok(isExecutable(path.join(CHECKOUT, RUNNER)))
  })

  it("prechecked_firstReviewOfThreeSourceFiles_countsAndCarriesItsMutationShapedTestsFindings", () => {
    givenReview({ runId: "rv-a", verdict: "NEEDS_FIXES", transcript: givenReport(NEEDS_FIXES_REPORT) })
    givenPrecheck()
    const result = runMetric()
    assert.equal(result.status, "PASS")
    assert.equal(result.count, 1)
    assert.deepEqual(result.items, [{
      run_id: "rv-a", created_at: NOW_TS, repos: ["flareshin/keel"], verdict: "NEEDS_FIXES", prechecked: true, mutation_tests_findings: 1,
    }])
  })

  it("firstReviewWithoutAPrecheckOfItsTree_isListedButNotCounted", () => {
    givenReview({ runId: "rv-a" })
    givenPrecheck(OTHER_TREE)
    const result = runMetric()
    assert.deepEqual([result.count, result.status], [0, "GRACE"])
    assert.deepEqual(result.items.map((item: { prechecked: boolean; mutation_tests_findings: number }) => [item.prechecked, item.mutation_tests_findings]), [[false, 0]])
  })

  it("deltaReviews_twoSourceFileDiffs_andReviewsBeforeTheWindow_areNotFirstReviewsTheRuleCovers", () => {
    givenReview({ runId: "rv-delta", since: "review-x" })
    givenReview({ runId: "rv-linked", rootRunId: "rv-root" })
    givenReview({ runId: "rv-small", paths: ["lib/a.ts", "lib/b.tsx", "tests/c.test.ts", "tests/d.test.ts", "README.md"] })
    givenReview({ runId: "rv-old", createdAt: addDays(TODAY, -90) + "T00:00:00Z" })
    givenPrecheck()
    const result = runMetric()
    assert.deepEqual([result.count, result.items], [0, []])
  })

  it("oneRunOverTwoRepos_isOneItem_countedOnlyWhenEveryCoveredRepoWasPrechecked", () => {
    givenReview({ runId: "rv-a", repo: "flareshin/keel" })
    givenReview({ runId: "rv-a", repo: "flareshin/keel-overlay", tree: OTHER_TREE })
    givenPrecheck()
    const result = runMetric()
    assert.equal(result.count, 0)
    assert.deepEqual(result.items.map((item: { repos: string[]; prechecked: boolean }) => [item.repos, item.prechecked]), [[["flareshin/keel", "flareshin/keel-overlay"], false]])
  })

  it("runsFromDifferentRepos_areListedInRunIdOrder_notEvidenceDirectoryOrder", () => {
    givenReview({ runId: "rv-20261020T000000Z-b", repo: "alpha/app" })
    givenReview({ runId: "rv-20261019T000000Z-a", repo: "zeta/app" })
    const result = runMetric()
    assert.deepEqual(result.items.map((item: { run_id: string }) => item.run_id), ["rv-20261019T000000Z-a", "rv-20261020T000000Z-b"])
  })

  it("needsFixesReportThatCannotBeReadOrHasNoBlockingSection_leavesTheFindingCountNull", () => {
    givenReview({ runId: "rv-a", verdict: "NEEDS_FIXES", transcript: path.join(box.root, "missing.jsonl") })
    givenReview({ runId: "rv-b", verdict: "NEEDS_FIXES", transcript: givenReport("VERDICT: NEEDS_FIXES\n\nThe reporter failed.") })
    givenPrecheck()
    const result = runMetric()
    assert.deepEqual([result.count, result.items.map((item: { mutation_tests_findings: number | null }) => item.mutation_tests_findings)], [2, [null, null]])
  })

  it("noReviewEvidenceOrPrecheckLog_countsZero_insteadOfFailing", () => {
    const result = runMetric()
    assert.deepEqual([result.count, result.items, result.status, result.error], [0, [], "GRACE", undefined])
  })
})
