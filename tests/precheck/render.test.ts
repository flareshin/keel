import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Census, CensusResult, MutationCensus } from "../../lib/precheck/census.ts"
import { renderCensus, renderRerun, summarizeCensus, summarizeRerun } from "../../lib/precheck/render.ts"

const TREE = "4f1c9e2a7b3d58e60c1f9a2b7d4e3c5a6b8d9e0f"
const BLOB_A = "9a1e".padEnd(40, "0")
const BLOB_B = "2c7b".padEnd(40, "1")
const DELETED = "0".repeat(40)

const result = (line: number, verdict: CensusResult["verdict"], coverage: CensusResult["coverage"] = "known"): CensusResult =>
  ({ path: "lib/a.ts", line, column: 7, operator: "logic-term", change: "a || b → a", coverage, verdict })

const ran = (overrides: Partial<Extract<MutationCensus, { outcome: "ran" }>> = {}): MutationCensus => ({
  outcome: "ran",
  timeoutSeconds: 600,
  baselineFiles: 4,
  baselinePasses: 118,
  withoutPasses: 0,
  baselineNotRun: [],
  results: [
    result(10, { outcome: "killed", test: "tests/a.test.ts" }),
    result(71, { outcome: "survived", ran: ["tests/a.test.ts", "tests/b.test.ts"] }),
    result(141, { outcome: "no test reaches" }),
    result(12, { outcome: "invalid", reason: "syntax" }),
    result(13, { outcome: "timeout", test: "tests/b.test.ts" }),
  ],
  notRun: [],
  elapsedMs: 372_400,
  ...overrides,
})

const census = (mutation: MutationCensus, overrides: Partial<Census> = {}): Census => ({
  tree: TREE,
  base: "origin/develop",
  paths: { source: 2, test: 1 },
  blobs: { "lib/a.ts": BLOB_A, "lib/gone.ts": DELETED },
  mutation,
  consumers: [
    { kind: "export", name: "pick", consumers: [{ path: "lib/b.ts", line: 58 }, { path: "lib/c.ts", line: 33 }] },
    { kind: "flag", name: "--quiet", consumers: [] },
  ],
  ...overrides,
})

describe("renderCensus", () => {
  it("renderCensus_writesTheTreeHeaderBlobsBaselineAndMutantCounts_forACompleteRun", () => {
    const lines = renderCensus(census(ran())).split("\n")

    assert.deepEqual(lines.slice(0, 4), [
      `precheck tree ${TREE} · base origin/develop · 3 paths (2 source, 1 test) · census (all candidates ran)`,
      `blobs     lib/a.ts ${BLOB_A} · lib/gone.ts ${DELETED}`,
      "baseline  4 test files · 118 pass · coverage collected · timeout 600s per file",
      "mutants   candidates 5 · killed 1 · survived 1 · no test reaches 1 · invalid 1 · timeout 1 · 6m12s",
    ])
  })

  it("renderCensus_listsSurvivorsWithTheFilesTheyRan_andMutantsNoTestReaches", () => {
    const text = renderCensus(census(ran({ results: [
      result(71, { outcome: "survived", ran: ["tests/a.test.ts", "tests/b.test.ts"] }),
      result(72, { outcome: "survived", ran: ["tests/a.test.ts"] }, "unknown"),
      result(141, { outcome: "no test reaches" }),
    ] })))

    assert.match(text, /\nsurvived\n  lib\/a\.ts:71:7  logic-term  a \|\| b → a  ran: tests\/a\.test\.ts, tests\/b\.test\.ts\n  lib\/a\.ts:72:7  logic-term  a \|\| b → a  ran: tests\/a\.test\.ts  coverage unknown\nno test reaches\n  lib\/a\.ts:141:7  logic-term  a \|\| b → a\n/)
  })

  it("renderCensus_marksANoTestReachesLineCoverageNeverSaw", () => {
    const text = renderCensus(census(ran({ results: [
      result(141, { outcome: "no test reaches" }),
      result(142, { outcome: "no test reaches" }, "unknown"),
    ] })))

    assert.match(text, /\nno test reaches\n  lib\/a\.ts:141:7  logic-term  a \|\| b → a\n  lib\/a\.ts:142:7  logic-term  a \|\| b → a  coverage unknown\n/u)
  })

  it("renderCensus_writesNoneForEmptyBlobs_andLeavesOutEmptySections", () => {
    const text = renderCensus(census(ran({ results: [result(10, { outcome: "killed", test: "tests/a.test.ts" })] }), { blobs: {} }))

    assert.match(text, /\nblobs     none\n/)
    assert.doesNotMatch(text, /\n(?:survived|timeout|no test reaches|not run)\n/)
  })

  it("renderCensus_listsTimedOutMutantsAfterSurvivors_withTheTestThatTimedOut", () => {
    const text = renderCensus(census(ran({ results: [
      result(71, { outcome: "survived", ran: ["tests/a.test.ts"] }),
      result(13, { outcome: "timeout", test: "tests/b.test.ts" }),
      result(141, { outcome: "no test reaches" }),
    ] })))

    assert.match(text, /\nsurvived\n  lib\/a\.ts:71:7  logic-term  a \|\| b → a  ran: tests\/a\.test\.ts\ntimeout\n  lib\/a\.ts:13:7  logic-term  a \|\| b → a  test: tests\/b\.test\.ts\nno test reaches\n  lib\/a\.ts:141:7  logic-term  a \|\| b → a\n/)
  })

  it("renderCensus_namesAPartialCheck_andListsTheMutantsThatDidNotRun", () => {
    const notRun = [{ path: "hooks/x.ts", line: 9, column: 7, operator: "boundary" as const, change: "> → >=" }]
    const text = renderCensus(census(ran({ notRun })))

    assert.match(text.split("\n")[0]!, / · partial check: 5 of 6 candidates ran$/)
    assert.match(text, /\nmutants   candidates 6 · killed 1 · survived 1 · no test reaches 1 · invalid 1 · timeout 1 · not run 1 · 6m12s\n/)
    assert.match(text, /\nnot run\n  hooks\/x\.ts:9:7  boundary  > → >=\n/)
  })

  it("renderCensus_countsBaselineFilesWithoutPasses_andWritesSecondsUnderAMinute", () => {
    const text = renderCensus(census(ran({ withoutPasses: 2, elapsedMs: 59_400 })))

    assert.match(text, /\nbaseline  4 test files · 118 pass · coverage collected · 2 without passes · timeout 600s per file\n/)
    assert.match(text, / · timeout 1 · 59s\n/)
  })

  it("renderCensus_callsARunPartial_andNamesTheFiles_whenTheBaselineBudgetCutItShort", () => {
    const lines = renderCensus(census(ran({ baselineNotRun: ["tests/x.test.ts", "tests/y.test.ts"] }))).split("\n")

    assert.match(lines[0]!, / · partial check: 5 of 5 candidates ran · baseline budget left 2 test files not run$/)
    assert.ok(lines.some((line) => line.startsWith("baseline ") && line.includes(" · not run 2 · ")), lines.join("\n"))
    assert.deepEqual(lines.slice(lines.indexOf("baseline not run"), lines.indexOf("baseline not run") + 3), ["baseline not run", "  tests/x.test.ts", "  tests/y.test.ts"])
  })

  it("renderCensus_printsTheEndOfARedFilesOutput_soTheReasonIsVisible", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")

    const lines = renderCensus(census({ outcome: "stopped", baseline: { outcome: "red", test: "tests/a.test.ts", output } })).split("\n")

    assert.ok(lines.includes("  line 29"), lines.join("\n"))
    assert.ok(lines.includes("  line 10"), lines.join("\n"))
    assert.ok(!lines.includes("  line 9"), lines.join("\n"))
  })

  it("renderCensus_addsNoOutputLine_whenARedFilePrintedNothing", () => {
    const lines = renderCensus(census({ outcome: "stopped", baseline: { outcome: "red", test: "tests/a.test.ts", output: "" } })).split("\n")

    assert.match(lines[2]!, /^consumers /)
  })

  it("renderCensus_namesTheBudget_andListsTheFiles_whenItRanOutBeforeAnyFilePassed", () => {
    const lines = renderCensus(census({ outcome: "stopped", baseline: { outcome: "budget", notRun: ["tests/x.test.ts", "tests/y.test.ts"] } })).split("\n")

    assert.deepEqual(lines.slice(1, 5), [
      "baseline  budget spent before any file passed · 2 test files not run · precheck stopped",
      "baseline not run",
      "  tests/x.test.ts",
      "  tests/y.test.ts",
    ])
  })

  it("renderCensus_dropsTheBlobsLine_whenTheBaselineStopsThePrecheck", () => {
    const stopped = [
      [{ outcome: "red", test: "tests/a.test.ts", output: "" }, "baseline  red in tests/a.test.ts · precheck stopped"],
      [{ outcome: "timeout", test: "tests/b.test.ts", output: "", timeoutSeconds: 600 }, "baseline  timeout after 600s in tests/b.test.ts · precheck stopped"],
      [{ outcome: "empty" }, "baseline  no candidate file ran a test · precheck stopped"],
    ] as const

    for (const [baseline, line] of stopped) {
      const lines = renderCensus(census({ outcome: "stopped", baseline })).split("\n")
      assert.match(lines[0]!, / · precheck stopped at baseline$/)
      assert.equal(lines[1], line)
      assert.ok(!lines.some((each) => each.startsWith("blobs")), lines.join("\n"))
    }
  })

  it("renderCensus_listsOnlyNamesWithConsumersOutsideTheDiff_underTheTotals", () => {
    const lines = renderCensus(census(ran())).split("\n")

    assert.deepEqual(lines.slice(-2), ["consumers 2 changed names · 2 consumers outside the diff", "  pick  lib/b.ts:58, lib/c.ts:33"])
  })
})

describe("summarizeCensus", () => {
  it("summarizeCensus_countsEachVerdictAndTheMutantsNotRun", () => {
    const notRun = [{ path: "hooks/x.ts", line: 9, column: 7, operator: "boundary" as const, change: "> → >=" }]

    assert.deepEqual(summarizeCensus(census(ran({ notRun }), { blobs: { "lib/a.ts": BLOB_B } })), {
      tree: TREE,
      base: "origin/develop",
      paths: { source: 2, test: 1 },
      outcome: "partial",
      mutants: { candidates: 6, killed: 1, survived: 1, "no test reaches": 1, invalid: 1, timeout: 1, not_run: 1 },
      baseline_not_run: 0,
      elapsed_ms: 372_400,
    })
  })

  it("summarizeCensus_isPartial_whenOnlyTheBaselineWasCutShort", () => {
    const summary = summarizeCensus(census(ran({ baselineNotRun: ["tests/x.test.ts"] })))

    assert.equal(summary["outcome"], "partial")
    assert.equal(summary["baseline_not_run"], 1)
  })

  it("summarizeCensus_recordsWhichBaselineOutcomeStoppedThePrecheck", () => {
    const summary = summarizeCensus(census({ outcome: "stopped", baseline: { outcome: "red", test: "tests/a.test.ts", output: "" } }))

    assert.equal(summary["outcome"], "stopped")
    assert.equal(summary["baseline"], "red")
    assert.equal(summary["baseline_test"], "tests/a.test.ts")
  })

  it("summarizeCensus_countsTheFilesNotRun_whenTheBudgetStoppedThePrecheck", () => {
    const summary = summarizeCensus(census({ outcome: "stopped", baseline: { outcome: "budget", notRun: ["tests/x.test.ts"] } }))

    assert.equal(summary["baseline"], "budget")
    assert.equal(summary["baseline_not_run"], 1)
  })

  it("summarizeCensus_namesNoTest_whenTheBaselineWasEmpty", () => {
    const summary = summarizeCensus(census({ outcome: "stopped", baseline: { outcome: "empty" } }))

    assert.equal(summary["baseline"], "empty")
    assert.equal("baseline_test" in summary, false)
  })
})

describe("renderRerun", () => {
  const mutant = { path: "lib/a.ts", line: 3, column: 7, operator: "boundary" as const, change: "> → >=" }

  it("renderRerun_countsAndListsMutantsTheBudgetLeft", () => {
    const text = renderRerun({ tree: "t", tests: ["tests/b.test.ts"], baselineNotRun: ["tests/c.test.ts"], results: [], notRun: [mutant] })

    assert.deepEqual(text.split("\n"), [
      "rerun: survivors · 0 killed · 0 survived · 0 no test reaches · 0 invalid · 0 timeout · 1 not run · tree t · ran tests/b.test.ts",
      "not run",
      "  lib/a.ts:3:7  boundary  > → >=",
      "baseline not run",
      "  tests/c.test.ts",
    ])
  })

  it("renderRerun_namesEveryMutantThatStaysOpen", () => {
    const text = renderRerun({ tree: "t", tests: ["tests/b.test.ts"], baselineNotRun: [], notRun: [], results: [
      { ...mutant, line: 1, coverage: "known", verdict: { outcome: "survived", ran: ["tests/b.test.ts"] } },
      { ...mutant, line: 2, coverage: "known", verdict: { outcome: "no test reaches" } },
      { ...mutant, line: 3, coverage: "known", verdict: { outcome: "invalid", reason: "no tests ran", tests: [] } },
      { ...mutant, line: 4, coverage: "known", verdict: { outcome: "timeout", test: "tests/b.test.ts" } },
    ] })

    assert.deepEqual(text.split("\n").slice(1), [
      "still survived",
      "  lib/a.ts:1:7  boundary  > → >=  ran: tests/b.test.ts",
      "still no test reaches",
      "  lib/a.ts:2:7  boundary  > → >=",
      "invalid",
      "  lib/a.ts:3:7  boundary  > → >=",
      "timeout",
      "  lib/a.ts:4:7  boundary  > → >=  test: tests/b.test.ts",
    ])
  })

  it("renderRerun_leavesOutNotRun_whenEveryMutantRan", () => {
    const text = renderRerun({ tree: "t", tests: ["tests/b.test.ts"], baselineNotRun: [], results: [{ ...mutant, coverage: "known", verdict: { outcome: "killed", test: "tests/b.test.ts" } }], notRun: [] })

    assert.equal(text, "rerun: survivors · 1 killed · 0 survived · 0 no test reaches · 0 invalid · 0 timeout · tree t · ran tests/b.test.ts")
  })

  it("summarizeRerun_countsEachVerdictAndWhatDidNotRun", () => {
    const summary = summarizeRerun({ tree: "t", tests: ["tests/b.test.ts"], baselineNotRun: ["tests/c.test.ts"], notRun: [mutant, mutant], results: [
      { ...mutant, coverage: "known", verdict: { outcome: "killed", test: "tests/b.test.ts" } },
      { ...mutant, coverage: "known", verdict: { outcome: "survived", ran: ["tests/b.test.ts"] } },
      { ...mutant, coverage: "known", verdict: { outcome: "survived", ran: ["tests/b.test.ts"] } },
      { ...mutant, coverage: "known", verdict: { outcome: "no test reaches" } },
      { ...mutant, coverage: "known", verdict: { outcome: "invalid", reason: "no tests ran", tests: [] } },
      { ...mutant, coverage: "known", verdict: { outcome: "timeout", test: "tests/b.test.ts" } },
    ] }, "trunk")

    assert.deepEqual(summary, {
      tree: "t",
      base: "trunk",
      outcome: "rerun",
      tests: ["tests/b.test.ts"],
      mutants: { killed: 1, survived: 2, "no test reaches": 1, invalid: 1, timeout: 1, not_run: 2 },
      baseline_not_run: ["tests/c.test.ts"],
    })
  })
})
