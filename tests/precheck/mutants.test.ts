import assert from "node:assert/strict"
import { describe, it } from "node:test"

const typescriptInstalled = await import("typescript").then(() => true, () => false)
type MutantsModule = typeof import("../../lib/precheck/mutants.ts")
const { generateMutants, applyMutant } = typescriptInstalled
  ? await import("../../lib/precheck/mutants.ts")
  : ({} as MutantsModule)

describe("generateMutants", { skip: typescriptInstalled ? false : "typescript is not installed; run npm ci" }, () => {
  const mutate = (lines: string[], changed: number[], operator?: string, fileName = "src/a.ts"): string[] => {
    const source = lines.join("\n")
    return generateMutants(fileName, source, new Set(changed))
      .filter((mutant) => operator === undefined || mutant.operator === operator)
      .map((mutant) => applyMutant(source, mutant))
  }
  const summarize = (lines: string[], changed: number[]): string[] =>
    generateMutants("src/a.ts", lines.join("\n"), new Set(changed)).map((mutant) => `${mutant.priority} ${mutant.operator} ${mutant.line}`)

  it("generateMutants_deletesACallStatement_andAnAwaitedOne", () => {
    const lines = ["lock(id)", "await save(id)", "const total = sum(id)"]

    assert.deepEqual(mutate(lines, [1, 2, 3], "call-removal"), [
      ";\nawait save(id)\nconst total = sum(id)",
      "lock(id)\n;\nconst total = sum(id)",
    ])
  })

  it("generateMutants_dropsEachTermOfALogicalExpression", () => {
    assert.deepEqual(mutate(["const ok = ready && allowed"], [1], "logic-term"), [
      "const ok = ready",
      "const ok = allowed",
    ])
    assert.deepEqual(mutate(["const ok = ready || allowed"], [1], "logic-term"), [
      "const ok = ready",
      "const ok = allowed",
    ])
  })

  it("generateMutants_negatesTheConditionOfAnIfAndATernary", () => {
    assert.deepEqual(mutate(["if (a < b) go()"], [1], "condition-negation"), ["if (!(a < b)) go()"])
    assert.deepEqual(mutate(["const v = ready ? 1 : 2"], [1], "condition-negation"), ["const v = !(ready) ? 1 : 2"])
  })

  it("generateMutants_movesEachComparisonBoundary", () => {
    const lines = ["const v = [a > b, a >= b, a < b, a <= b]"]

    assert.deepEqual(mutate(lines, [1], "boundary"), [
      "const v = [a >= b, a >= b, a < b, a <= b]",
      "const v = [a > b, a > b, a < b, a <= b]",
      "const v = [a > b, a >= b, a <= b, a <= b]",
      "const v = [a > b, a >= b, a < b, a < b]",
    ])
  })

  it("generateMutants_leavesGenericsArrowsEqualityAndOperatorsInsideStringsAlone", () => {
    const lines = ["const f = (xs: Array<number>): boolean => xs.length === 0", "const label = 'a && b > c'"]

    assert.deepEqual(mutate(lines, [1, 2], "boundary"), [])
    assert.deepEqual(mutate(lines, [1, 2], "logic-term"), [])
  })

  it("generateMutants_pinsAReturnedValueToEachConstant_andSkipsTheOneItAlreadyIs", () => {
    const lines = ["function f() {", "  return total", "}"]

    assert.deepEqual(mutate(lines, [2], "return-constant"), [
      "function f() {\n  return null\n}",
      "function f() {\n  return []\n}",
      "function f() {\n  return false\n}",
    ])
    assert.equal(mutate(["function f() {", "  return null", "}"], [2], "return-constant").length, 2)
    assert.deepEqual(mutate(["function f() {", "  return", "}"], [2], "return-constant"), [])
  })

  it("generateMutants_emptiesACatchBody_andRemovesARethrowThatSitsBesideOtherStatements", () => {
    const lines = ["try {", "  run()", "} catch (error) {", "  log(error)", "  throw error", "}"]

    assert.deepEqual(mutate(lines, [4], "catch-swallow"), ["try {\n  run()\n} catch (error) {}"])
    assert.deepEqual(mutate(lines, [5], "catch-swallow"), [
      "try {\n  run()\n} catch (error) {}",
      "try {\n  run()\n} catch (error) {\n  log(error)\n  ;\n}",
    ])
  })

  it("generateMutants_emptiesACatchWhoseOnlyStatementIsARethrow_withoutASecondMutant", () => {
    const lines = ["try {", "  run()", "} catch (error) {", "  throw error", "}"]

    assert.deepEqual(mutate(lines, [4], "catch-swallow"), ["try {\n  run()\n} catch (error) {}"])
  })

  it("generateMutants_leavesAnAlreadyEmptyCatchAlone", () => {
    assert.deepEqual(mutate(["try {", "  run()", "} catch (error) { }"], [3], "catch-swallow"), [])
  })

  it("generateMutants_keepsAThrowInsideANestedFunctionOfACatch", () => {
    const lines = ["try {", "  run()", "} catch (error) {", "  log(error)", "  later(() => { throw error })", "}"]

    assert.deepEqual(mutate(lines, [5], "catch-swallow"), ["try {\n  run()\n} catch (error) {}"])
  })

  it("generateMutants_swapsFindAndFilterOnlyWhereTheyAreCalled", () => {
    const lines = ["const one = items.find(isOpen)", "const all = items.filter(isOpen)", "const method = items.find"]

    assert.deepEqual(mutate(lines, [1, 2, 3], "aggregate-swap"), [
      "const one = items.filter(isOpen)\nconst all = items.filter(isOpen)\nconst method = items.find",
      "const one = items.find(isOpen)\nconst all = items.find(isOpen)\nconst method = items.find",
    ])
  })

  it("generateMutants_removesEachSentenceOfAPromptString", () => {
    const lines = ["const prompt = 'Read the diff. Never edit files! Report back?'"]

    assert.deepEqual(mutate(lines, [1], "text-removal"), [
      "const prompt = 'Never edit files! Report back?'",
      "const prompt = 'Read the diff. Report back?'",
      "const prompt = 'Read the diff. Never edit files!'",
    ])
  })

  it("generateMutants_leavesAOneSentenceStringAndADottedNameWhole", () => {
    const lines = ["const a = 'Read the diff. '", "const b = 'lib/precheck/mutants.ts'", "const c = `v1.2 is out`"]

    assert.deepEqual(mutate(lines, [1, 2, 3], "text-removal"), [])
  })

  it("generateMutants_removesEachEntryOfAStringList_withItsComma", () => {
    const lines = ["const allowed = ['PASS', 'NEEDS_FIXES', 'BLOCKED']", "const mixed = ['PASS', 1]"]

    assert.deepEqual(mutate(lines, [1, 2], "text-removal"), [
      "const allowed = ['NEEDS_FIXES', 'BLOCKED']\nconst mixed = ['PASS', 1]",
      "const allowed = ['PASS', 'BLOCKED']\nconst mixed = ['PASS', 1]",
      "const allowed = ['PASS', 'NEEDS_FIXES']\nconst mixed = ['PASS', 1]",
    ])
  })

  it("generateMutants_mutatesOnlyCodeThatTouchesAChangedLine", () => {
    const lines = ["lock(id)", "unlock(id)", "notify({", "  id,", "})"]

    assert.deepEqual(summarize(lines, [2, 4]), ["1 call-removal 2", "1 call-removal 3"])
  })

  it("generateMutants_ordersByPriorityThenPosition", () => {
    const lines = ["if (a && b) {", "  save()", "  return items.find(isOpen)", "}"]

    assert.deepEqual(summarize(lines, [1, 2, 3]), [
      "1 call-removal 2",
      "2 logic-term 1",
      "2 logic-term 1",
      "3 condition-negation 1",
      "5 return-constant 3",
      "5 return-constant 3",
      "5 return-constant 3",
      "7 aggregate-swap 3",
    ])
  })

  it("generateMutants_producesOnlySourceThatStillParses", async () => {
    const ts = (await import("typescript")).default
    const lines = [
      "export function check(items: string[]): string[] | null {",
      "  if (items.length > 0 && ready()) audit(items)",
      "  else notify()",
      "  try {",
      "    return items.filter((item) => item <= 'z')",
      "  } catch (error) {",
      "    report(error)",
      "    throw error",
      "  }",
      "}",
      "const labels = <const>['Stop. Think.', 'Go']",
    ]
    const source = lines.join("\n")
    const mutants = generateMutants("src/a.ts", source, new Set(lines.map((_, index) => index + 1)))

    assert.equal(new Set(mutants.map((mutant) => mutant.operator)).size, 8)
    for (const mutant of mutants) {
      const output = ts.transpileModule(applyMutant(source, mutant), { fileName: "src/a.ts", reportDiagnostics: true })
      assert.deepEqual(output.diagnostics, [], `${mutant.operator} at ${mutant.line} broke the syntax`)
    }
  })
})
