import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { ruleCheckDiff } from "../../measure/evals/lib/evalkit/readability.ts"
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
