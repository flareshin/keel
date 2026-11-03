import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { evalGraderDiff, ruleCheckDiff } from "../../measure/evals/lib/evalkit/readability.ts"
import { CHECKOUT } from "./helpers.ts"

function addedFileDiff(file: string, lines: string[]): string {
  const body = lines.map((line) => "+" + line + "\n").join("")
  return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}`
}

describe("ruleCheckDiff", () => {
  let fixture: string

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fixture"))
    fs.writeFileSync(path.join(fixture, "README.md"), "# shop\n")
  })
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }))

  it("ruleCheckDiff_findsNoSignal_forAReadableAddition", () => {
    const diff = addedFileDiff("src/total.ts", ["export function orderTotalCents(lines: number[]): number {", "  return lines.reduce((sum, cents) => sum + cents, 0)", "}"])
    assert.deepEqual(ruleCheckDiff(CHECKOUT, fixture, diff), { signals: [] })
  })

  it("ruleCheckDiff_reportsTheSignal_forAnEmptyCatchAndABannedName", () => {
    const diff = addedFileDiff("src/load.ts", ["export function load(run: () => void): void {", "  const data = 1", "  try { run() } catch (e) {}", "}"])
    const check = ruleCheckDiff(CHECKOUT, fixture, diff)
    assert.ok("signals" in check)
    assert.deepEqual(check.signals.map((line) => line.split(" ").slice(0, 3).join(" ")), ["signal K5.5 src/load.ts:2", "signal K5.12 src/load.ts:3"])
  })

  it("ruleCheckDiff_findsNoSignal_forAnEmptyDiff", () => {
    assert.deepEqual(ruleCheckDiff(CHECKOUT, fixture, ""), { signals: [] })
  })

  it("ruleCheckDiff_faults_namingTheMissingScript_whenTheCheckoutHasNoRuleChecks", () => {
    const emptyCheckout = fs.mkdtempSync(path.join(os.tmpdir(), "checkout"))
    try {
      const check = ruleCheckDiff(emptyCheckout, fixture, "")
      assert.ok("fault" in check)
      assert.ok(check.fault.startsWith("rule-checks exit 1: "), check.fault)
      assert.ok(check.fault.includes("rule-checks.ts"), check.fault)
    } finally {
      fs.rmSync(emptyCheckout, { recursive: true, force: true })
    }
  })

  it("ruleCheckDiff_faults_withTheSummaryLine_whenRuleChecksIsBlocked", () => {
    const fakeCheckout = fs.mkdtempSync(path.join(os.tmpdir(), "checkout"))
    const summary = "summary repos=0 scanned_lines=0 signals=0 unscanned=none blocked=.(crashed: KeyError)"
    try {
      const script = path.join(fakeCheckout, "skills", "writing-readable-code", "scripts", "rule-checks.ts")
      fs.mkdirSync(path.dirname(script), { recursive: true })
      fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(summary + "\n")})\nprocess.stderr.write("Error: scan failed\\n")\nprocess.exit(2)\n`)
      assert.deepEqual(ruleCheckDiff(fakeCheckout, fixture, ""), { fault: `rule-checks exit 2: ${summary}` })
    } finally {
      fs.rmSync(fakeCheckout, { recursive: true, force: true })
    }
  })

  it("ruleCheckDiff_faults_whenTheDiffDoesNotApply", () => {
    const check = ruleCheckDiff(CHECKOUT, fixture, "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# other\n+# shop desk\n")
    assert.ok("fault" in check)
    assert.ok(check.fault.startsWith("rule-checks could not rebuild the diff: git apply --index - failed"), check.fault)
  })

  it("ruleCheckDiff_leavesTheFixtureUntouched", () => {
    ruleCheckDiff(CHECKOUT, fixture, addedFileDiff("src/x.ts", ["export const x = 1"]))
    assert.deepEqual(fs.readdirSync(fixture), ["README.md"])
  })
})

describe("evalGraderDiff with the C-no-comments grader", () => {
  const COMMENTED = "// sum of cents\nexport const total = 1\n"
  const hunkDiff = (hunk: string) => `diff --git a/src/total.ts b/src/total.ts\n--- a/src/total.ts\n+++ b/src/total.ts\n${hunk}`
  let fixture: string

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fixture"))
    fs.mkdirSync(path.join(fixture, "src"))
    fs.writeFileSync(path.join(fixture, "src", "total.ts"), COMMENTED)
  })
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }))

  it("evalGraderDiff_reportsTheComment_thatAChangedFileStillHolds", () => {
    const diff = hunkDiff("@@ -1,2 +1,2 @@\n // sum of cents\n-export const total = 1\n+export const total = 2\n")
    assert.deepEqual(evalGraderDiff(CHECKOUT, "C-no-comments", fixture, diff), { signals: ["signal C-no-comments src/total.ts: // sum of cents"] })
  })

  it("evalGraderDiff_findsNoSignal_whenTheChangeRemovesTheComment", () => {
    const diff = hunkDiff("@@ -1,2 +1 @@\n-// sum of cents\n export const total = 1\n")
    assert.deepEqual(evalGraderDiff(CHECKOUT, "C-no-comments", fixture, diff), { signals: [] })
  })

  it("evalGraderDiff_keepsToolDirectivesAndLegalNotices", () => {
    const diff = addedFileDiff("src/coupon.ts", ["// Copyright 2024 Stockroom Ltd.", "// eslint-disable-next-line no-console", "console.log(1)"])
    assert.deepEqual(evalGraderDiff(CHECKOUT, "C-no-comments", fixture, diff), { signals: [] })
  })

  it("evalGraderDiff_reportsTheComment_inAFileWithANonAsciiPath", () => {
    const diff = addedFileDiff("src/café.ts", ["// sum of cents", "export const total = 1"])
    assert.deepEqual(evalGraderDiff(CHECKOUT, "C-no-comments", fixture, diff), { signals: ["signal C-no-comments src/café.ts: // sum of cents"] })
  })

  it("evalGraderDiff_faults_namingTheEval_whenItHasNoGradeScript", () => {
    const check = evalGraderDiff(CHECKOUT, "K4", fixture, "")
    assert.ok("fault" in check)
    assert.ok(check.fault.startsWith("K4 grader exit 1: "), check.fault)
  })
})

describe("evalGraderDiff with the C-authoring-agents grader", () => {
  const GOOD = ["---", "name: log-reader", "description: Reads a CI log and returns the failing test names. Not for fixing them.", "tools: Read, Grep", "---", "You read one CI log."]
  let fixture: string

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fixture"))
    fs.writeFileSync(path.join(fixture, "README.md"), "# desk\n")
  })
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }))

  const grade = (file: string, lines: string[]) => evalGraderDiff(CHECKOUT, "C-authoring-agents", fixture, addedFileDiff(file, lines))

  it("evalGraderDiff_findsNoSignal_forACompleteAgentDefinition", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD), { signals: [] })
  })

  it("evalGraderDiff_reportsAnAgentWithoutAToolsList", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD.filter((line) => !line.startsWith("tools:"))), { signals: ["signal C-authoring-agents agents/log-reader.md: no tools list"] })
  })

  it("evalGraderDiff_reportsANameThatIsNotTheFileName", () => {
    assert.deepEqual(grade("agents/ci-logs.md", GOOD), { signals: ['signal C-authoring-agents agents/ci-logs.md: name "log-reader" is not the file name'] })
  })

  it("evalGraderDiff_reportsAnAgentWithoutDescription", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD.filter((line) => !line.startsWith("description:"))), { signals: ["signal C-authoring-agents agents/log-reader.md: no description"] })
  })

  it("evalGraderDiff_reportsAFileWithoutFrontmatter", () => {
    assert.deepEqual(grade("agents/log-reader.md", ["You read one CI log."]), { signals: ["signal C-authoring-agents agents/log-reader.md: no frontmatter"] })
  })

  it("evalGraderDiff_reportsAReviewerThatPinsModel", () => {
    const reviewer = ["---", "name: sql-reviewer", "description: Reviews SQL migrations and returns a verdict.", "tools: Read", "model: haiku", "---", "You review."]
    assert.deepEqual(grade("agents/sql-reviewer.md", reviewer), { signals: ["signal C-authoring-agents agents/sql-reviewer.md: a reviewer or verifier pins model"] })
  })

  it("evalGraderDiff_findsNoSignal_forAReviewerWithoutModel", () => {
    const reviewer = ["---", "name: sql-reviewer", "description: Reviews SQL migrations and returns a verdict.", "tools: Read", "---", "You review."]
    assert.deepEqual(grade("agents/sql-reviewer.md", reviewer), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forAWorkerThatPinsModel", () => {
    assert.deepEqual(grade("agents/log-reader.md", [...GOOD.slice(0, 4), "model: haiku", ...GOOD.slice(4)]), { signals: [] })
  })

  it("evalGraderDiff_reportsAVerifierNamedOnlyInTheDescription_thatPinsModel", () => {
    const verifier = ["---", "name: test-rerunner", "description: Verifies a fix by rerunning the failing test.", "tools: Bash, Read", "model: haiku", "---", "You rerun."]
    assert.deepEqual(grade("agents/test-rerunner.md", verifier), { signals: ["signal C-authoring-agents agents/test-rerunner.md: a reviewer or verifier pins model"] })
  })

  it("evalGraderDiff_reportsAReviewerNamedOnlyInTheName_thatPinsModel", () => {
    const reviewer = ["---", "name: sql-reviewer", "description: Checks SQL migrations and returns a verdict.", "tools: Read", "model: haiku", "---", "You check."]
    assert.deepEqual(grade("agents/sql-reviewer.md", reviewer), { signals: ["signal C-authoring-agents agents/sql-reviewer.md: a reviewer or verifier pins model"] })
  })

  it("evalGraderDiff_reportsAnEmptyToolsField_thatAnotherFieldFollows", () => {
    const lines = ["---", "name: log-reader", "tools:", "description: Reads a CI log and returns the failing test names.", "---", "You read one CI log."]
    assert.deepEqual(grade("agents/log-reader.md", lines), { signals: ["signal C-authoring-agents agents/log-reader.md: no tools list"] })
  })

  it("evalGraderDiff_findsNoSignal_forAWorkerThatRulesReviewOut_andPinsModel", () => {
    const drafter = ["---", "name: notes-drafter", "description: Drafts release notes from the git log. Not for reviewing or verifying the release.", "tools: Read, Write", "model: haiku", "---", "You draft."]
    assert.deepEqual(grade("agents/notes-drafter.md", drafter), { signals: [] })
  })

  const pinnedModel = (name: string, description: string) => ["---", `name: ${name}`, `description: ${description}`, "tools: Read", "model: haiku", "---", "You work."]

  for (const description of [
    "Drafts release notes from the git log. Do not use for fixing bugs, reviewing diffs or verifying fixes.",
    "Drafts release notes from the git log and never reviews them.",
    "Drafts release notes from the git log. Don't use it to verify the release.",
    "Drafts release notes from the git log. Never use it to review the release.",
    "Lists keys missing from any locale file, not for verifying translations.",
    "Drafts release notes and does NOT verify them.",
    "Do not use for writing code, or reviewing it.",
    "Do not use for writing code, and reviewing it.",
  ]) {
    it(`evalGraderDiff_findsNoSignal_forAWorkerThatRulesReviewOut_andPinsModel: ${description}`, () => {
      assert.deepEqual(grade("agents/notes-drafter.md", pinnedModel("notes-drafter", description)), { signals: [] })
    })
  }

  for (const description of [
    "Annotates diffs and reviews them for typos.",
    "Not for drafting; reviews SQL migrations.",
    "Not for drafting. Reviews SQL migrations.",
    "Notes each change and reviews the diff.",
    "Reads the release notes and verifies each linked ticket is closed.",
    "Runs whenever a fix lands and verifies the test passes.",
    "Reruns a test that did not pass before a fix and verifies whether it now passes.",
    "Does not edit code, only verifies.",
    "Checks the style rules a linter cannot review.",
    "Never edits code, only verifies.",
    "Never writes files, only reviews the incoming diff.",
    "Not for fixing bugs, singles out and reviews risky diffs.",
    "Drafts release notes, reviewing each linked diff.",
  ]) {
    it(`evalGraderDiff_reportsAReviewerWhoseRoleNoRuleOutReaches_thatPinsModel: ${description}`, () => {
      assert.deepEqual(grade("agents/diff-checker.md", pinnedModel("diff-checker", description)), { signals: ["signal C-authoring-agents agents/diff-checker.md: a reviewer or verifier pins model"] })
    })
  }

  it("evalGraderDiff_findsNoSignal_forASingleQuotedName", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD.map((line) => (line === "name: log-reader" ? "name: 'log-reader'" : line))), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forAToolsBlockListAtColumnZero", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD.flatMap((line) => (line.startsWith("tools:") ? ["tools:", "- Read", "- Grep"] : [line]))), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forAQuotedName", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD.map((line) => (line === "name: log-reader" ? 'name: "log-reader"' : line))), { signals: [] })
  })

  it("evalGraderDiff_findsNoSignal_forAToolsBlockList", () => {
    assert.deepEqual(grade("agents/log-reader.md", GOOD.flatMap((line) => (line.startsWith("tools:") ? ["tools:", "  - Read", "  - Grep"] : [line]))), { signals: [] })
  })

  it("evalGraderDiff_reportsARunThatChangesNoAgentFile", () => {
    assert.deepEqual(grade("notes/log-reader.md", GOOD), { signals: ["signal C-authoring-agents -: no agents/<name>.md file changed"] })
  })
})
