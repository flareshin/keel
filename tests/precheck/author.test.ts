import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ruleCheckOutputLines } from "../../lib/precheck/author.ts"

describe("ruleCheckOutputLines", () => {
  it("prefixesEveryLine_andAddsTheExitCodeAndEachStderrLine_whenRuleChecksExitsNonZero", () => {
    const completed = { returncode: 2, stdout: Buffer.from("summary repos=1 scanned_lines=0 signals=0 unscanned=none blocked=vendor/sub\n"), stderr: Buffer.from("Error: boom\n    at scan (rule-checks.ts:1)\n") }

    assert.deepEqual(ruleCheckOutputLines(completed), [
      "rule-checks totals repos=1 scanned_lines=0 signals=0 unscanned=none blocked=vendor/sub",
      "rule-checks exit 2",
      "rule-checks Error: boom",
      "rule-checks     at scan (rule-checks.ts:1)",
    ])
  })

  it("printsOnlyTheStdoutLines_withTheSummaryRenamedSoLensReviewDoesNotCountIt_whenRuleChecksExitsZero", () => {
    const completed = { returncode: 0, stdout: Buffer.from("summary repos=1 scanned_lines=2 signals=0 unscanned=none blocked=none\n"), stderr: Buffer.from("ignored\n") }

    assert.deepEqual(ruleCheckOutputLines(completed), ["rule-checks totals repos=1 scanned_lines=2 signals=0 unscanned=none blocked=none"])
  })
})
