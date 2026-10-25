import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { snapshotTree } from "../../lib/evidence/gitcmd.ts"
import { materializeTree, runBaseline } from "../../lib/precheck/baseline.ts"
import type { BaselineFile } from "../../lib/precheck/baseline.ts"
import type { Mutant } from "../../lib/precheck/mutants.ts"

const typescriptInstalled = await import("typescript").then(() => true, () => false)
type RunModule = typeof import("../../lib/precheck/run.ts")
const { runMutants } = typescriptInstalled ? await import("../../lib/precheck/run.ts") : ({} as RunModule)

const TIMEOUT_SECONDS = 60
const PICK = "export function pick(flag: boolean): number {\n  if (flag) return 1\n  return 2\n}\n"
const PICK_TEST = "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\nit('picks', () => assert.equal(pick(true), 1))\n"

describe("runMutants", { skip: typescriptInstalled ? false : "typescript is not installed; run npm ci" }, () => {
  const directories: string[] = []
  after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
  const checkout = async (files: Record<string, string>, tests: string[]): Promise<{ directory: string; files: BaselineFile[] }> => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "precheck-run-")))
    directories.push(root)
    execFileSync("git", ["init", "-q", root])
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "fixture"])
    const directory = materializeTree(root, snapshotTree(root))
    directories.push(directory)
    const baseline = await runBaseline(directory, tests, TIMEOUT_SECONDS)
    assert.equal(baseline.outcome, "green")
    return { directory, files: baseline.files }
  }
  const mutantAt = (source: string, original: string, replacement: string, line: number): Mutant => {
    const start = source.indexOf(original)
    assert.notEqual(start, -1)
    return { priority: 1, operator: "condition-negation", line, start, end: start + original.length, replacement }
  }

  it("runMutants_killsAMutantThatABaselineTestCatches_andRestoresTheFile", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "flag)", "!flag)", 2) }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["known", { outcome: "killed", test: "tests/a.test.ts" }]])
    assert.deepEqual(run.notRun, [])
    assert.equal(readFileSync(join(directory, "lib", "a.ts"), "utf8"), PICK)
  })

  it("runMutants_reportsASurvivor_withTheTestsThatRan", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "return 1", "return 1 + 0", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "survived", ran: ["tests/a.test.ts"] })
  })

  it("runMutants_reportsNoTestReaches_forALineNoBaselineTestRan_withoutRunningIt", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "return 2", "return (", 3) }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["known", { outcome: "no test reaches" }]])
  })

  it("runMutants_runsOnlyTheTestFilesThatExecutedTheMutatedLine", async () => {
    const { directory, files } = await checkout({
      "lib/a.ts": PICK,
      "lib/b.ts": "export const b = () => 2\n",
      "tests/a.test.ts": PICK_TEST,
      "tests/b.test.ts": "import { it } from 'node:test'\nimport { writeFileSync } from 'node:fs'\nimport { b } from '../lib/b.ts'\nit('b', () => { writeFileSync('b-ran', ''); b() })\n",
    }, ["tests/a.test.ts", "tests/b.test.ts"])
    rmSync(join(directory, "b-ran"))

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "return 1", "return 1 + 0", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "survived", ran: ["tests/a.test.ts"] })
    assert.equal(existsSync(join(directory, "b-ran")), false)
  })

  it("runMutants_runsEveryBaselineFile_whenTheMutatedFileNeverAppearedInCoverage", async () => {
    const script = "return 'ready'\n"
    const { directory, files } = await checkout({
      "lib/run.js": script,
      "tests/a.test.ts": "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('compiles', () => assert.equal(new Function(readFileSync('lib/run.js', 'utf8'))(), 'ready'))\n",
    }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/run.js", mutant: mutantAt(script, "'ready'", "null", 1) }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["unknown", { outcome: "killed", test: "tests/a.test.ts" }]])
  })

  it("runMutants_runsTheFastestBaselineFileFirst_andStopsAtTheFirstKill", async () => {
    const slow = "import assert from 'node:assert/strict'\nimport { writeFileSync } from 'node:fs'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\nit('slow', async () => { writeFileSync('slow-ran', ''); await new Promise((resolve) => setTimeout(resolve, 1500)); assert.equal(pick(true), 1) })\n"
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/slow.test.ts": slow, "tests/a.test.ts": PICK_TEST }, ["tests/slow.test.ts", "tests/a.test.ts"])
    rmSync(join(directory, "slow-ran"))

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "flag)", "!flag)", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "killed", test: "tests/a.test.ts" })
    assert.equal(existsSync(join(directory, "slow-ran")), false)
  })

  it("runMutants_marksASyntaxErrorInvalid_withoutTouchingTheFile", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "if (flag)", "if (", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "invalid", reason: "syntax" })
    assert.equal(readFileSync(join(directory, "lib", "a.ts"), "utf8"), PICK)
  })

  it("runMutants_marksAMutantThatLeavesNoPassingTestInvalid", async () => {
    const flag = "export const enabled = true\n"
    const { directory, files } = await checkout({
      "lib/flag.ts": flag,
      "tests/a.test.ts": "import { describe, it } from 'node:test'\nimport { enabled } from '../lib/flag.ts'\ndescribe('gated', { skip: !enabled }, () => { it('runs', () => {}) })\n",
    }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/flag.ts", mutant: mutantAt(flag, "true", "false", 1) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "invalid", reason: "no tests ran", test: "tests/a.test.ts" })
  })

  it("runMutants_reportsATimeoutForAMutantThatHangs_andRestoresTheFile", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "if (flag) return 1", "while (flag) {}", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "timeout", test: "tests/a.test.ts" })
    assert.equal(readFileSync(join(directory, "lib", "a.ts"), "utf8"), PICK)
  })

  it("runMutants_leavesTheMutantsPastTheBudgetUnrun", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])
    const first = { path: "lib/a.ts", mutant: mutantAt(PICK, "flag)", "!flag)", 2) }
    const second = { path: "lib/a.ts", mutant: mutantAt(PICK, "return 1", "return 1 + 0", 2) }

    const none = await runMutants(directory, files, [first, second], 0)
    const one = await runMutants(directory, files, [first, second], 1)

    assert.deepEqual(none, { results: [], notRun: [first, second] })
    assert.deepEqual(one.results.map((result) => result.verdict.outcome), ["killed"])
    assert.deepEqual(one.notRun, [second])
  })
})
