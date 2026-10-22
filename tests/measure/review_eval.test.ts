import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { CaseError } from "../../measure/evals/lib/evalkit/cases.ts"
import { loadReviewCases } from "../../measure/evals/lib/evalkit/reviewcases.ts"
import type { ReviewCase } from "../../measure/evals/lib/evalkit/reviewcases.ts"
import { gradeResult, suiteNumbers } from "../../measure/evals/lib/evalkit/reviewgrade.ts"
import { BuildError, buildCaseRepo } from "../../measure/evals/lib/evalkit/reviewrun.ts"
import { runGit } from "../../measure/lib/measurekit/gitutil.ts"
import type { JsonObject } from "../../measure/lib/measurekit/pyvalue.ts"
import { CHECKOUT, MeasureSandbox, readText } from "./helpers.ts"
import type { Completed } from "./helpers.ts"

const REVIEW_EVAL = path.join(CHECKOUT, "measure", "evals", "review-eval.ts")
const REVIEW_STUB_DIR = path.join(CHECKOUT, "tests", "measure", "stubs", "review")
const CASES = path.join("measure", "evals", "review", "cases")
const BASE_TEXT = "export function total(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0)\n}\n"
const CHANGE = [
  "diff --git a/calc.ts b/calc.ts", "--- a/calc.ts", "+++ b/calc.ts", "@@ -1,3 +1,7 @@",
  " export function total(items: number[]): number {", "   return items.reduce((sum, item) => sum + item, 0)", " }",
  "+", "+export function mean(items: number[]): number {", "+  return total(items) / items.length", "+}", "",
].join("\n")
const DEFECT_LINE = 6

interface WriteCaseOptions {
  split?: string
  lens?: string
  locations?: { file: string; line: number }[]
  base?: boolean
  change?: string
}

function writeCase(checkout: string, caseId: string, options: WriteCaseOptions = {}): string {
  const { split = "train", lens = "boundary", base = true, change = CHANGE } = options
  const directory = path.join(checkout, CASES, caseId)
  fs.mkdirSync(directory, { recursive: true })
  if (base) {
    fs.mkdirSync(path.join(directory, "base"), { recursive: true })
    fs.writeFileSync(path.join(directory, "base", "calc.ts"), BASE_TEXT)
  }
  fs.writeFileSync(path.join(directory, "change.diff"), change)
  const locations = options.locations ?? (lens === "control" ? [] : [{ file: "calc.ts", line: DEFECT_LINE }])
  fs.writeFileSync(path.join(directory, "expect.json"), JSON.stringify({ lens, must_find: "mean divides by zero on an empty list", source: "test", split, locations }))
  return directory
}

function finding(quote: string, file: string = "{{REPO}}/calc.ts", impact: string = "high"): JsonObject {
  return { id: "f1", summary: "s", impact, file, quote, repro: "static: contract at calc.ts:6" }
}

function result(blocking: JsonObject[] = [], nonBlocking: JsonObject[] = []): JsonObject {
  return { verdict: blocking.length > 0 ? "NEEDS_FIXES" : "PASS", blocking, nonBlocking }
}

describe("cases", () => {
  let root: string
  let keel: string
  let overlay: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-review-cases-"))
    keel = path.join(root, "keel")
    overlay = path.join(root, "overlay")
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("load_mergesKeelAndOverlayCases", () => {
    writeCase(keel, "mean-1")
    writeCase(overlay, "control-1", { lens: "control", split: "holdout" })
    const cases = loadReviewCases([keel, overlay])
    assert.deepEqual(cases.map((c) => [c.id, c.split, c.isClean, c.locations.length]), [["mean-1", "train", false, 1], ["control-1", "holdout", true, 0]])
  })

  it("load_refusesTheSameIdInBothCheckouts", () => {
    writeCase(keel, "mean-1")
    writeCase(overlay, "mean-1")
    assert.throws(() => loadReviewCases([keel, overlay]), (error) => error instanceof CaseError && /in both/.test(error.message))
  })

  it("load_refusesAControlCaseWithLocations", () => {
    writeCase(keel, "control-1", { lens: "control", locations: [{ file: "calc.ts", line: 1 }] })
    assert.throws(() => loadReviewCases([keel]), (error) => error instanceof CaseError && /no locations/.test(error.message))
  })

  it("load_refusesADefectCaseWithoutLocations", () => {
    writeCase(keel, "mean-1", { locations: [] })
    assert.throws(() => loadReviewCases([keel]), (error) => error instanceof CaseError && /at least one/.test(error.message))
  })

  it("load_refusesALocationOutsideTheRepo", () => {
    writeCase(keel, "mean-1", { locations: [{ file: "../calc.ts", line: 1 }] })
    assert.throws(() => loadReviewCases([keel]), (error) => error instanceof CaseError && /relative/.test(error.message))
  })

  it("load_namesTheMissingAndUnknownKeysInPythonListSpelling", () => {
    const directory = writeCase(keel, "mean-1")
    fs.writeFileSync(path.join(directory, "expect.json"), JSON.stringify({ lens: "boundary", extra: 1 }))
    assert.throws(
      () => loadReviewCases([keel]),
      (error) => error instanceof CaseError && error.message.endsWith("missing ['must_find', 'source', 'split', 'locations'], unknown ['extra']"),
    )
  })
})

describe("build", () => {
  let root: string
  let keel: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-review-build-"))
    keel = path.join(root, "keel")
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("build_commitsTheBaseThenTheChange", () => {
    writeCase(keel, "mean-1")
    const reviewCase = loadReviewCases([keel])[0] as ReviewCase
    const { repo, base, head } = buildCaseRepo(reviewCase, path.join(root, "work"))
    assert.equal(runGit(repo, ["show", base + ":calc.ts"]), BASE_TEXT)
    assert.ok(runGit(repo, ["diff", base, head]).includes("+export function mean(items: number[]): number {"))
    assert.equal(runGit(repo, ["status", "--porcelain"]), "")
  })

  it("build_appliesTheChange_whenTheCheckoutPathIsRelative", () => {
    writeCase(keel, "mean-1")
    const reviewCase = loadReviewCases([path.relative(process.cwd(), keel)])[0] as ReviewCase
    const { repo, base, head } = buildCaseRepo(reviewCase, path.join(root, "work"))
    assert.ok(runGit(repo, ["diff", base, head]).includes("+export function mean(items: number[]): number {"))
  })

  it("build_refusesALocationPastTheEndOfTheFile", () => {
    writeCase(keel, "mean-1", { locations: [{ file: "calc.ts", line: 8 }] })
    const reviewCase = loadReviewCases([keel])[0] as ReviewCase
    assert.throws(
      () => buildCaseRepo(reviewCase, path.join(root, "work")),
      (error) => error instanceof BuildError && error.message.includes("no such line") && error.message.includes("Location(file='calc.ts', line=8)"),
    )
  })

  it("build_refusesAChangeThatDoesNotApply", () => {
    writeCase(keel, "mean-1", { base: false })
    const reviewCase = loadReviewCases([keel])[0] as ReviewCase
    assert.throws(() => buildCaseRepo(reviewCase, path.join(root, "work")), BuildError)
  })
})

describe("grade", () => {
  let root: string
  let defect: ReviewCase
  let clean: ReviewCase

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-review-grade-"))
    const keel = path.join(root, "keel")
    writeCase(keel, "mean-1")
    writeCase(keel, "control-1", { lens: "control" })
    ;[defect, clean] = loadReviewCases([keel]).sort((left, right) => Number(left.isClean) - Number(right.isClean)) as [ReviewCase, ReviewCase]
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("blockingFindingAtTheLine_isAHit", () => {
    const grade = gradeResult(defect, 1, result([finding("/tmp/x/app/calc.ts:6 `return total(items) / items.length`")]))
    assert.deepEqual([grade.hit, grade.passed, grade.blocking], [true, true, 1])
  })

  it("lineToleranceIsThreeLinesEitherSide", () => {
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:9")])).hit, true)
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:3")])).hit, true)
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:10")])).hit, false)
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:2")])).hit, false)
  })

  it("aQuotedRangeOverlappingTheWindow_isAHit", () => {
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:10-12")])).hit, false)
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:1-3")])).hit, true)
  })

  it("bareLineRef_countsOnlyWhenTheFindingsFileIsTheExpectedOne", () => {
    assert.equal(gradeResult(defect, 1, result([finding("line :6 divides")])).hit, true)
    assert.equal(gradeResult(defect, 1, result([finding("line :6 divides", "{{REPO}}/other.ts")])).hit, false)
  })

  it("anotherFileAtTheSameLine_isAMiss", () => {
    assert.equal(gradeResult(defect, 1, result([finding("other.ts:6", "{{REPO}}/other.ts")])).hit, false)
  })

  it("anotherFileWithTheSameSuffix_isAMiss", () => {
    assert.equal(gradeResult(defect, 1, result([finding("xcalc.ts:6", "{{REPO}}/xcalc.ts")])).hit, false)
  })

  it("nonBlockingFindingAtTheLine_isAMiss", () => {
    const grade = gradeResult(defect, 1, result([], [finding("calc.ts:6", "{{REPO}}/calc.ts", "low")]))
    assert.deepEqual([grade.hit, grade.passed, grade.blocking], [false, false, 0])
  })

  it("cleanCase_failsOnAnyBlockingFinding", () => {
    assert.equal(gradeResult(clean, 1, result([], [finding("calc.ts:6", "{{REPO}}/calc.ts", "low")])).passed, true)
    const noisy = gradeResult(clean, 1, result([finding("calc.ts:6"), finding("calc.ts:1")]))
    assert.deepEqual([noisy.passed, noisy.blocking, noisy.hit], [false, 2, false])
  })

  it("quotedLineNumbers_writtenInAnotherScriptsDigits_areReadByTheirValue", () => {
    assert.equal(gradeResult(defect, 1, result([finding("calc.ts:٦")])).hit, true)
  })

  it("suiteNumbers_recallNoiseVarianceAgreement", () => {
    const grades = [
      gradeResult(defect, 1, result([finding("calc.ts:6")])),
      gradeResult(defect, 2, result()),
      gradeResult(clean, 1, result()),
      gradeResult(clean, 2, result([finding("calc.ts:1")])),
    ]
    const numbers = suiteNumbers(grades)
    const train = numbers.train
    assert.deepEqual(
      [train.defect_runs, train.hits, train.recall?.value, train.clean_runs, train.noisy_runs, train.noise_rate?.value, train.blocking_per_clean_run?.value, train.recall_stdev?.value],
      [2, 1, 0.5, 2, 1, 0.5, 0.5, 0.5],
    )
    assert.deepEqual([numbers.case_agreement?.value, numbers.headroom, numbers.holdout.recall], [0, true, null])
  })

  it("suiteNumbers_reportNoHeadroomWhenTrainIsPerfect", () => {
    const grades = [gradeResult(defect, 1, result([finding("calc.ts:6")])), gradeResult(clean, 1, result())]
    assert.equal(suiteNumbers(grades).headroom, false)
  })
})

describe("review-eval cli", () => {
  let box: MeasureSandbox
  let scenarios: string

  beforeEach(() => {
    box = new MeasureSandbox()
    scenarios = path.join(box.root, "scenarios")
    fs.mkdirSync(scenarios)
    Object.assign(box.env, { PATH: REVIEW_STUB_DIR + path.delimiter + (box.env["PATH"] ?? ""), KEEL_TEST_SCENARIOS: scenarios, CLAUDE_CONFIG_DIR: box.data })
    writeCase(box.keel, "mean-1")
    writeCase(box.keel, "mean-2", { split: "holdout" })
    writeCase(box.keel, "control-1", { lens: "control" })
  })
  afterEach(() => box.cleanup())

  const play = (rounds: object[]) => fs.writeFileSync(path.join(scenarios, "review.json"), JSON.stringify({ rounds }))

  function runEval(...args: string[]): [Completed, any] {
    const completed = spawnSync(process.execPath, [REVIEW_EVAL, ...args], { encoding: "utf8", env: box.env, cwd: box.root })
    return [completed, completed.stdout.trim() ? JSON.parse(completed.stdout) : null]
  }

  const calls = (): any[] => readText(path.join(scenarios, "calls.jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line))

  function summaryLines(): any[] {
    const file = path.join(box.data, "logs", "keel-review-eval.jsonl")
    return fs.existsSync(file) ? readText(file).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
  }

  it("fullRun_printsRecallNoiseAndVariance_andLogsOneSummaryLine", () => {
    const hit = { result: result([finding("{{REPO}}/calc.ts:6 `return total(items) / items.length`")]) }
    play([{ result: result() }, { result: result() }, hit, hit, hit, { result: result() }])
    const [completed, report] = runEval("--repeat", "2")
    assert.equal(completed.status, 0, completed.stderr)
    const numbers = report.numbers
    assert.deepEqual([numbers.train.recall, numbers.train.noise_rate, numbers.holdout.recall, numbers.holdout.recall_stdev], [1.0, 0.0, 0.5, 0.5])
    assert.deepEqual([numbers.case_agreement, numbers.headroom, report.faults], [Math.round((2 / 3) * 10000) / 10000, false, []])
    assert.ok(completed.stderr.includes("review-eval train: recall 1.0 (2/2), noise 0.0 (0/2 clean runs)"), completed.stderr)
    assert.deepEqual(summaryLines().map((line) => line.numbers), [numbers])
    assert.deepEqual(fs.readdirSync(path.join(box.data, "projects")), [])
  })

  it("fullRun_writesFloatsTheWayPythonDoes_inStdoutAndTheSummaryLog", () => {
    play([{ result: result() }, { result: result() }, { result: result() }])
    const [completed] = runEval("--repeat", "1")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(completed.stdout.includes('"recall": 0.0'), completed.stdout)
    assert.ok(completed.stdout.includes('"case_agreement": null'), completed.stdout)
    assert.ok(completed.stdout.includes('"noise_rate": 0.0'), completed.stdout)
    assert.ok(readText(path.join(box.data, "logs", "keel-review-eval.jsonl")).includes('"noise_rate": 0.0'))
  })

  it("prompt_namesTheWorkflowTheBuiltRangeAndTheCallerSkill", () => {
    const expectPath = path.join(box.keel, CASES, "mean-1", "expect.json")
    const expect = JSON.parse(readText(expectPath))
    Object.assign(expect, { caller_skill: "demo-lenses", requirement: "Add a mean helper." })
    fs.writeFileSync(expectPath, JSON.stringify(expect))
    play([{ result: result() }])
    const [completed] = runEval("--case", "mean-1", "--repeat", "1")
    assert.equal(completed.status, 0, completed.stderr)
    const call = calls()[0]
    const workflowArgs = JSON.parse(call.prompt.split("\n")[1])
    assert.deepEqual([workflowArgs.diffs[0].repo, workflowArgs.requirement], [call.cwd, "Add a mean helper."])
    assert.ok(call.prompt.includes("the skill demo-lenses"))
    assert.ok(call.argv.includes("--disallowedTools"))
    assert.ok(!call.argv.join(" ").includes("disableAllHooks"))
    assert.deepEqual(summaryLines(), [])
  })

  it("runWithoutAWorkflowRecord_isAFault_notAMiss", () => {
    play([{ record: false }])
    const [completed, report] = runEval("--case", "mean-1", "--repeat", "1")
    assert.equal(completed.status, 1)
    assert.deepEqual([report.faults[0].case, report.numbers.train.defect_runs], ["mean-1", 0])
    assert.ok(report.faults[0].reason.includes("no lens-review workflow record"))
  })

  it("erroredWorkflow_isAFault", () => {
    play([{ result: { verdict: "ERROR", error: "prepare failed" } }])
    const [completed, report] = runEval("--case", "mean-1", "--repeat", "1")
    assert.equal(completed.status, 1)
    assert.ok(report.faults[0].reason.includes("prepare failed"))
  })

  it("faultedFullRun_writesNoSummaryLine", () => {
    play([{ result: result() }, { record: false }, { result: result() }])
    const [completed] = runEval("--repeat", "1")
    assert.deepEqual([completed.status, summaryLines()], [1, []])
  })

  it("regrade_gradesTheSameRecordsTheSame_andCatchesAChangedGrade", () => {
    play([{ result: result([finding("{{REPO}}/calc.ts:6")]) }])
    const [, report] = runEval("--case", "mean-1", "--repeat", "1")
    const rawDir = report.raw_dir
    const [same, sameReport] = runEval("--regrade", rawDir)
    const expectPath = path.join(box.keel, CASES, "mean-1", "expect.json")
    const expect = JSON.parse(readText(expectPath))
    expect.locations = [{ file: "calc.ts", line: 1 }]
    fs.writeFileSync(expectPath, JSON.stringify(expect))
    const [changed, changedReport] = runEval("--regrade", rawDir)
    assert.deepEqual([same.status, sameReport.same_grade, sameReport.runs], [0, 1, 1])
    assert.deepEqual([changed.status, changedReport.same_grade], [1, 0])
    assert.equal(calls().length, 1)
  })

  it("gradesTheLatestLensReviewRecordOfTheSession_whateverTheFileOrder", () => {
    const latest = { startTime: 9, result: result([finding("{{REPO}}/calc.ts:6")]) }
    const earlier = { startTime: 1, result: { verdict: "ERROR", error: "earlier attempt" } }
    const newestOther = { startTime: 20, workflowName: "other-workflow", result: result() }
    play([{ records: [latest, earlier, newestOther] }, { records: [earlier, latest, newestOther] }])
    const [completed, report] = runEval("--case", "mean-1", "--repeat", "2")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual([report.faults, report.numbers.train.hits], [[], 2])
  })

  describe("faults", () => {
    const cases: [object, string[], string][] = [
      [{ status: "killed", result: result() }, [], "status 'killed'"],
      [{ result: { verdict: "PASS" } }, [], "no blocking list"],
      [{ result: result(), sleep: 5 }, ["--timeout-seconds", "1"], "timed out after 1s"],
    ]
    for (const [scenario, extra, reason] of cases) {
      it(`killedRecord_resultWithoutBlockingList_andTimeout_areFaults: ${reason}`, () => {
        play([scenario])
        const [completed, report] = runEval("--case", "mean-1", "--repeat", "1", ...extra)
        assert.equal(completed.status, 1)
        assert.ok(report.faults[0].reason.includes(reason), report.faults[0].reason)
        assert.equal(report.numbers.train.defect_runs, 0)
      })
    }
  })

  it("reportAndSummaryLine_carryTheReviewerFingerprint", () => {
    const workflow = path.join(box.data, "workflows", "lens-review.js")
    fs.mkdirSync(path.dirname(workflow), { recursive: true })
    fs.writeFileSync(workflow, "export const meta = {}\n")
    play([{ result: result() }])
    const [completed, report] = runEval("--repeat", "1")
    assert.equal(completed.status, 0, completed.stderr)
    const expected = { "lens-review.js": createHash("sha256").update("export const meta = {}\n").digest("hex"), "adversarial-audit.js": null }
    assert.deepEqual([report.reviewer, summaryLines()[0].reviewer], [expected, expected])
  })

  it("dryRun_buildsEveryCaseAndCallsNothing", () => {
    const [completed, plan] = runEval("--dry-run")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(plan.cases.map((c: { id: string }) => c.id), ["control-1", "mean-1", "mean-2"])
    assert.equal(fs.existsSync(path.join(scenarios, "calls.jsonl")), false)
  })

  it("caseThatDoesNotBuild_stopsTheRunBeforeAnyReview", () => {
    writeCase(box.keel, "mean-3", { base: false })
    const [completed] = runEval("--repeat", "1")
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("mean-3"))
    assert.equal(fs.existsSync(path.join(scenarios, "calls.jsonl")), false)
  })

  it("exitTwo_whenRegradeIsMixedWithACaseOption", () => {
    const [completed] = runEval("--regrade", path.join(box.root, "nowhere"), "--case", "mean-1")
    assert.equal(completed.status, 2)
  })
})

describe("shipped cases", () => {
  const DEFECT_SNIPPETS: Record<string, string> = {
    "sample-injection-1": "${customer}",
    "sample-pagination-1": "Math.floor",
  }

  it("keelCasesBuildAndPointAtExistingLines", () => {
    const cases = loadReviewCases([CHECKOUT])
    assert.deepEqual(cases.map((c) => [c.split, c.isClean] as const).sort().map((entry) => entry.join(" ")), ["holdout false", "train false", "train true"])
    for (const reviewCase of cases) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "keel-shipped-case-"))
      try {
        buildCaseRepo(reviewCase, path.join(work, reviewCase.id))
      } finally {
        fs.rmSync(work, { recursive: true, force: true })
      }
    }
  })

  it("everyExpectedLocation_pointsAtTheDefectExpressionOfItsCase_inThePostChangeFile", () => {
    const cases = loadReviewCases([CHECKOUT])
    const defectCases = cases.filter((c) => !c.isClean)
    assert.deepEqual(defectCases.map((c) => c.id).sort(), Object.keys(DEFECT_SNIPPETS).sort())
    for (const reviewCase of defectCases) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "keel-shipped-case-"))
      try {
        const { repo } = buildCaseRepo(reviewCase, path.join(work, reviewCase.id))
        for (const location of reviewCase.locations) {
          const lines = readText(path.join(repo, location.file)).split("\n")
          assert.ok(lines.length >= location.line, `${reviewCase.id}: ${location.file} has ${lines.length} lines`)
          assert.ok((lines[location.line - 1] as string).includes(DEFECT_SNIPPETS[reviewCase.id] as string), `${reviewCase.id}: line ${location.line} is ${lines[location.line - 1]}`)
        }
      } finally {
        fs.rmSync(work, { recursive: true, force: true })
      }
    }
  })

  it("everyBaseFileOfAShippedCase_isTypeScript", () => {
    for (const reviewCase of loadReviewCases([CHECKOUT]).filter((c) => c.id !== "sample-pagination-1")) {
      const files = fs.readdirSync(reviewCase.baseDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      assert.ok(files.length > 0, reviewCase.id)
      assert.deepEqual(files.filter((entry) => !entry.name.endsWith(".ts")).map((entry) => entry.name), [], reviewCase.id)
    }
  })
})
