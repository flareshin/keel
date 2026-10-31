import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { scanFences } from "../../measure/lib/measurekit/fences.ts"

describe("scanFences", () => {
  it("marksFenceLinesAndContents_asFenced", () => {
    assert.deepEqual(scanFences(["text", "```ts", "code", "```", "after"]).fenced, [false, true, true, true, false])
  })

  it("reportsUnclosedBlock_andFencesTheRestOfTheFile", () => {
    const scan = scanFences(["text", "```ts", "code"])
    assert.deepEqual(scan.problems, ["line 2: code block is never closed"])
    assert.deepEqual(scan.fenced, [false, true, true])
  })

  it("reportsEqualLengthNesting_withAnInfoString", () => {
    assert.deepEqual(scanFences(["```markdown", "```bash", "x", "```"]).problems,
      ["line 2: a fence with an info string inside the block opened at line 1 does not nest; lengthen the outer fence"])
  })

  it("keepsAShorterInnerFenceInside_aLongerOuterFence", () => {
    const scan = scanFences(["````markdown", "```bash", "x", "```", "````", "after"])
    assert.deepEqual(scan.problems, [])
    assert.deepEqual(scan.fenced, [true, true, true, true, true, false])
  })

  it("closesOnlyWithTheSameMarker", () => {
    assert.deepEqual(scanFences(["~~~", "```", "~~~", "after"]).fenced, [true, true, true, false])
  })

  it("treatsALineOpeningWithInlineCode_asText", () => {
    const scan = scanFences(["```foo``` is inline code", "text"])
    assert.deepEqual(scan.problems, [])
    assert.deepEqual(scan.fenced, [false, false])
  })
})
