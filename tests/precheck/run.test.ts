import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { snapshotTree } from "../../lib/evidence/gitcmd.ts"
import { materializeTree, runBaseline } from "../../lib/precheck/baseline.ts"
import type { BaselineFile } from "../../lib/precheck/baseline.ts"
import type { Mutant } from "../../lib/precheck/mutants.ts"
import { committedRepo } from "./fixture.ts"

const typescriptInstalled = await import("typescript").then(() => true, () => false)
type RunModule = typeof import("../../lib/precheck/run.ts")
const { mutantTimeoutSeconds, runMutants } = typescriptInstalled ? await import("../../lib/precheck/run.ts") : ({} as RunModule)

const TIMEOUT_SECONDS = 60
const PICK = "export function pick(flag: boolean): number {\n  if (flag) return 1\n  return 2\n}\n"
const PICK_TEST = "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\nit('picks', () => assert.equal(pick(true), 1))\n"

describe("runMutants", { skip: typescriptInstalled ? false : "typescript is not installed; run npm ci" }, () => {
  const directories: string[] = []
  after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
  const checkout = async (files: Record<string, string>, tests: string[]): Promise<{ directory: string; files: BaselineFile[] }> => {
    const root = committedRepo(files)
    directories.push(root)
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

  it("runMutants_reportsNoTestReaches_forACatchBlockNoBaselineTestEntered_thoughItsLineStartsWithExecutedCode", async () => {
    const load = "export function load(read: () => string): string {\n  try {\n    return read()\n  } catch (error) {\n    console.error('failed', error)\n    throw error\n  }\n}\n"
    const { directory, files } = await checkout({
      "lib/a.ts": load,
      "tests/a.test.ts": "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { load } from '../lib/a.ts'\nit('loads', () => assert.equal(load(() => 'x'), 'x'))\n",
    }, ["tests/a.test.ts"])
    const block = load.slice(load.indexOf("{\n    console"), load.indexOf("  }\n}") + 3)

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(load, block, "{}", 4) }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["known", { outcome: "no test reaches" }]])
  })

  it("runMutants_reportsNoTestReaches_forAnUnenteredCatchClause_whoseNeighboursRanRightUpToItsEdges", async () => {
    const load = "export function load(read: () => string): string {\n  try {\n    return read()\n  }catch (error) {\n    throw error\n  }}\n"
    const { directory, files } = await checkout({
      "lib/a.ts": load,
      "tests/a.test.ts": "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { load } from '../lib/a.ts'\nit('loads', () => assert.equal(load(() => 'x'), 'x'))\n",
    }, ["tests/a.test.ts"])
    const clause = load.slice(load.indexOf("catch"), load.lastIndexOf("}"))

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(load, clause, "finally {}", 4) }])

    assert.deepEqual(run.results.map((result) => result.verdict), [{ outcome: "no test reaches" }])
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

  it("runMutants_runsEveryBaselineFileThatReadsTheMutatedFile_whenItNeverAppearedInCoverage", async () => {
    const script = "return 'ready'\n"
    const compiling = "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('compiles', () => assert.equal(new Function(readFileSync('lib/run.js', 'utf8'))(), 'ready'))\n"
    const { directory, files } = await checkout({
      "lib/run.js": script,
      "tests/a.test.ts": compiling,
      "tests/b.test.ts": compiling,
    }, ["tests/a.test.ts", "tests/b.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/run.js", mutant: mutantAt(script, "'ready'", "'rea' + 'dy'", 1) }])

    const [result] = run.results
    assert.equal(result?.coverage, "unknown")
    assert.equal(result?.verdict.outcome, "survived")
    assert.deepEqual(result?.verdict.outcome === "survived" ? [...result.verdict.ran].sort() : [], ["tests/a.test.ts", "tests/b.test.ts"])
  })

  it("runMutants_reportsNoTestReaches_forAFileNoTestReads_withoutRunningAnyTest", async () => {
    const script = "return 'ready'\n"
    const unrelated = "import { appendFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('unrelated', () => appendFileSync('runs', 'x'))\n"
    const { directory, files } = await checkout({ "lib/run.js": script, "tests/a.test.ts": unrelated }, ["tests/a.test.ts"])
    rmSync(join(directory, "runs"))
    const mutant = mutantAt(script, "'ready'", "'rea' + 'dy'", 1)

    const run = await runMutants(directory, files, [{ path: "lib/run.js", mutant }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["unknown", { outcome: "no test reaches" }]])
    assert.equal(existsSync(join(directory, "runs")), false)
  })

  it("runMutants_runsOnlyTheTestFilesThatReadAFileCoverageNeverSaw", async () => {
    const script = "return 'ready'\n"
    const compiling = "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('compiles', () => assert.equal(new Function(readFileSync('lib/run.js', 'utf8'))(), 'ready'))\n"
    const unrelated = "import { it } from 'node:test'\nit('unrelated', () => {})\n"
    const { directory, files } = await checkout({ "lib/run.js": script, "tests/a.test.ts": compiling, "tests/b.test.ts": unrelated }, ["tests/a.test.ts", "tests/b.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/run.js", mutant: mutantAt(script, "'ready'", "'rea' + 'dy'", 1) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "survived", ran: ["tests/a.test.ts"] })
  })

  it("runMutants_killsWithATestThatReadsTheFile_howeverItSpellsThePath_thoughItOnlyAssertsAbsence", async () => {
    const guard = "export function ok(a, b) {\n  if (a && b) return true\n  return false\n}\n"
    const absence = "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { it } from 'node:test'\nit('stays positive', () => assert.doesNotMatch(readFileSync(join('lib', 'guard.js'), 'utf8'), /!\\(/u))\n"
    const { directory, files } = await checkout({ "lib/guard.js": guard, "tests/a.test.ts": absence }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/guard.js", mutant: mutantAt(guard, "a && b", "!(a && b)", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "killed", test: "tests/a.test.ts" })
  })

  it("runMutants_leavesATestThatOnlyMentionsThePathOutOfTheSelection", async () => {
    const script = "return 'ready'\n"
    const mentioning = "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nit('splits', () => assert.equal('lib/run.js'.split('/').length, 2))\n"
    const { directory, files } = await checkout({ "lib/run.js": script, "tests/a.test.ts": mentioning }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/run.js", mutant: mutantAt(script, "'ready'", "'rea' + 'dy'", 1) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "no test reaches" })
  })

  it("runMutants_killsWithADirectoryWalkAssertingAPropertyOfEachFile", async () => {
    const guard = "export const rule = 'a && b'\n"
    const walking = "import assert from 'node:assert/strict'\nimport { readdirSync, readFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('every rule file holds the rule', () => { for (const name of readdirSync('lib')) assert.ok(readFileSync('lib/' + name, 'utf8').includes('a && b'), name) })\n"
    const { directory, files } = await checkout({ "lib/guard.js": guard, "lib/other.js": guard, "tests/a.test.ts": walking }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/guard.js", mutant: mutantAt(guard, "'a && b'", "'a || b'", 1) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "killed", test: "tests/a.test.ts" })
  })

  const READ_SPELLINGS: Array<[string, string]> = [
    ["fsPromisesReadFile", "import { readFile } from 'node:fs/promises'\nconst source = await readFile('lib/guard.js', 'utf8')\n"],
    ["fsPromisesOpen", "import { open } from 'node:fs/promises'\nconst handle = await open('lib/guard.js')\nconst source = await handle.readFile('utf8')\nawait handle.close()\n"],
    ["callbackReadFile", "import { readFile } from 'node:fs'\nconst source = await new Promise((done) => readFile('lib/guard.js', 'utf8', (_error, text) => done(text)))\n"],
    ["fileUrl", "import { readFileSync } from 'node:fs'\nimport { pathToFileURL } from 'node:url'\nconst source = readFileSync(pathToFileURL('lib/guard.js'), 'utf8')\n"],
    ["readStream", "import { createReadStream } from 'node:fs'\nimport { text } from 'node:stream/consumers'\nconst source = await text(createReadStream('lib/guard.js'))\n"],
    ["openAndReadSync", "import { closeSync, openSync, readSync } from 'node:fs'\nconst fd = openSync('lib/guard.js', 'r')\nconst buffer = Buffer.alloc(100)\nconst source = buffer.toString('utf8', 0, readSync(fd, buffer))\ncloseSync(fd)\n"],
    ["spawnedNodeChildInAnotherDirectory", "import { execFileSync } from 'node:child_process'\nconst source = execFileSync(process.execPath, ['-e', \"process.stdout.write(require('node:fs').readFileSync('guard.js', 'utf8'))\"], { cwd: 'lib', encoding: 'utf8' })\n"],
    ["copiedFile", "import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = join(mkdtempSync(join(tmpdir(), 'keel-read-trace-')), 'guard.js')\ncopyFileSync('lib/guard.js', copy)\nconst source = readFileSync(copy, 'utf8')\n"],
    ["copiedDirectory", "import { cpSync, mkdtempSync, readFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = mkdtempSync(join(tmpdir(), 'keel-read-trace-'))\ncpSync('lib', copy, { recursive: true })\nconst source = readFileSync(join(copy, 'guard.js'), 'utf8')\n"],
    ["callbackOpen", "import { open, readFileSync } from 'node:fs'\nconst source = await new Promise((done) => open('lib/guard.js', 'r', (_error, fd) => done(readFileSync(fd, 'utf8'))))\n"],
    ["callbackCopyFile", "import { mkdtempSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = mkdtempSync(join(tmpdir(), 'keel-read-trace-'))\nimport { copyFile, readFileSync } from 'node:fs'\nawait new Promise((done) => copyFile('lib/guard.js', join(copy, 'guard.js'), done))\nconst source = readFileSync(join(copy, 'guard.js'), 'utf8')\n"],
    ["callbackCp", "import { mkdtempSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = mkdtempSync(join(tmpdir(), 'keel-read-trace-'))\nimport { cp, readFileSync } from 'node:fs'\nawait new Promise((done) => cp('lib', copy, { recursive: true }, done))\nconst source = readFileSync(join(copy, 'guard.js'), 'utf8')\n"],
    ["fsPromisesCopyFile", "import { mkdtempSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = mkdtempSync(join(tmpdir(), 'keel-read-trace-'))\nimport { readFileSync } from 'node:fs'\nimport { copyFile } from 'node:fs/promises'\nawait copyFile('lib/guard.js', join(copy, 'guard.js'))\nconst source = readFileSync(join(copy, 'guard.js'), 'utf8')\n"],
    ["fsPromisesCp", "import { mkdtempSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = mkdtempSync(join(tmpdir(), 'keel-read-trace-'))\nimport { readFileSync } from 'node:fs'\nimport { cp } from 'node:fs/promises'\nawait cp('lib', copy, { recursive: true })\nconst source = readFileSync(join(copy, 'guard.js'), 'utf8')\n"],
    ["bufferPath", "import { readFileSync } from 'node:fs'\nconst source = readFileSync(Buffer.from('lib/guard.js'), 'utf8')\n"],
    ["symlinkOutsideTheRepo", "import { mkdtempSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nconst copy = mkdtempSync(join(tmpdir(), 'keel-read-trace-'))\nimport { readFileSync, symlinkSync } from 'node:fs'\nimport { resolve } from 'node:path'\nsymlinkSync(resolve('lib/guard.js'), join(copy, 'link.js'))\nconst source = readFileSync(join(copy, 'link.js'), 'utf8')\n"],
    ["promisifiedReadFile", "import { readFile } from 'node:fs'\nimport { promisify } from 'node:util'\nconst source = await promisify(readFile)('lib/guard.js', 'utf8')\n"],
    ["workerThreadFromAFile", "import { once } from 'node:events'\nimport { mkdtempSync, writeFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { Worker } from 'node:worker_threads'\nconst script = join(mkdtempSync(join(tmpdir(), 'keel-read-trace-')), 'read.cjs')\nwriteFileSync(script, \"require('node:worker_threads').parentPort.postMessage(require('node:fs').readFileSync('lib/guard.js', 'utf8'))\")\nconst [source] = await once(new Worker(script), 'message')\n"],
    ["spawnedNodeChildWithoutKeelSettings", "import { execFileSync } from 'node:child_process'\nconst env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('KEEL_')))\nconst source = execFileSync(process.execPath, ['-e', \"process.stdout.write(require('node:fs').readFileSync('lib/guard.js', 'utf8'))\"], { encoding: 'utf8', env })\n"],
  ]
  for (const [spelling, reading] of READ_SPELLINGS) {
    it(`runMutants_killsWithATestThatReadsTheFileBy_${spelling}`, async () => {
      const guard = "export const rule = 'a && b'\n"
      const test = reading + "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nit('holds the rule', () => assert.ok(source.includes('a && b')))\n"
      const { directory, files } = await checkout({ "lib/guard.js": guard, "tests/a.test.ts": test }, ["tests/a.test.ts"])

      const run = await runMutants(directory, files, [{ path: "lib/guard.js", mutant: mutantAt(guard, "'a && b'", "'a || b'", 1) }])

      assert.deepEqual(run.results[0]?.verdict, { outcome: "killed", test: "tests/a.test.ts" })
    })
  }

  it("runMutants_leavesATestThatOnlyChecksTheFileExistsOutOfTheSelection", async () => {
    const script = "return 'ready'\n"
    const existing = "import assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\nimport { it } from 'node:test'\nit('exists', () => assert.ok(existsSync('lib/run.js')))\n"
    const { directory, files } = await checkout({ "lib/run.js": script, "tests/a.test.ts": existing }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/run.js", mutant: mutantAt(script, "'ready'", "'rea' + 'dy'", 1) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "no test reaches" })
  })

  it("runMutants_reportsNoTestReaches_forALineARequiredCommonJsModuleNeverRan", async () => {
    const script = "module.exports = function pick(flag) {\n  if (flag) return 1\n  return 2\n}\n"
    const requiring = "import assert from 'node:assert/strict'\nimport { createRequire } from 'node:module'\nimport { it } from 'node:test'\nconst pick = createRequire(import.meta.url)('../lib/pick.cjs')\nit('picks', () => assert.equal(pick(true), 1))\n"
    const { directory, files } = await checkout({ "lib/pick.cjs": script, "tests/a.test.ts": requiring }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/pick.cjs", mutant: mutantAt(script, "return 2", "return 3", 3) }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["known", { outcome: "no test reaches" }]])
  })

  it("runMutants_reportsNoTestReaches_forALineARequiredModuleNeverRan_underAnInheritedCopyOfThePreload", async () => {
    const copy = mkdtempSync(join(tmpdir(), "keel-outer-preload-"))
    directories.push(copy)
    copyFileSync(join(import.meta.dirname, "..", "..", "lib", "precheck", "read-trace-preload.mjs"), join(copy, "read-trace-preload.mjs"))
    const inherited = process.env["NODE_OPTIONS"]
    process.env["NODE_OPTIONS"] = `--import=${pathToFileURL(join(copy, "read-trace-preload.mjs")).href}`
    try {
      const script = "module.exports = function pick(flag) {\n  if (flag) return 1\n  return 2\n}\n"
      const requiring = "import assert from 'node:assert/strict'\nimport { createRequire } from 'node:module'\nimport { it } from 'node:test'\nconst pick = createRequire(import.meta.url)('../lib/pick.cjs')\nit('picks', () => assert.equal(pick(true), 1))\n"
      const { directory, files } = await checkout({ "lib/pick.cjs": script, "tests/a.test.ts": requiring }, ["tests/a.test.ts"])

      const run = await runMutants(directory, files, [{ path: "lib/pick.cjs", mutant: mutantAt(script, "return 2", "return 3", 3) }])

      assert.deepEqual(run.results[0]?.verdict, { outcome: "no test reaches" })
    } finally {
      if (inherited === undefined) delete process.env["NODE_OPTIONS"]
      else process.env["NODE_OPTIONS"] = inherited
    }
  })

  it("runMutants_selectsATestThatReadsAFileAnotherTestRan_forALineTheOtherNeverRan", async () => {
    const reading = "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { it } from 'node:test'\nit('holds both returns', () => assert.ok(readFileSync('lib/a.ts', 'utf8').includes('return 2')))\n"
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST, "tests/b.test.ts": reading }, ["tests/a.test.ts", "tests/b.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "return 2", "return 3", 3) }])

    assert.deepEqual(run.results.map((result) => [result.coverage, result.verdict]), [["known", { outcome: "killed", test: "tests/b.test.ts" }]])
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

    assert.deepEqual(run.results[0]?.verdict, { outcome: "invalid", reason: "no tests ran", tests: ["tests/a.test.ts"] })
  })

  it("runMutants_movesPastAFileTheMutantLeftWithoutPasses_toAFileThatKillsIt", async () => {
    const flag = "export const enabled = true\n"
    const { directory, files } = await checkout({
      "lib/flag.ts": flag,
      "tests/a.test.ts": "import { describe, it } from 'node:test'\nimport { enabled } from '../lib/flag.ts'\ndescribe('gated', { skip: !enabled }, () => { it('runs', () => {}) })\n",
      "tests/b.test.ts": "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { enabled } from '../lib/flag.ts'\nit('enabled', async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); assert.equal(enabled, true) })\n",
    }, ["tests/a.test.ts", "tests/b.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/flag.ts", mutant: mutantAt(flag, "true", "false", 1) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "killed", test: "tests/b.test.ts" })
  })

  it("runMutants_reportsATimeoutForAMutantThatHangs_andRestoresTheFile", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])

    const run = await runMutants(directory, files, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "if (flag) return 1", "while (flag) {}", 2) }])

    assert.deepEqual(run.results[0]?.verdict, { outcome: "timeout", test: "tests/a.test.ts" })
    assert.equal(readFileSync(join(directory, "lib", "a.ts"), "utf8"), PICK)
  })

  it("runMutants_letsASlowMutantFinish_whenTheHostIsBusierThanDuringItsBaselineFile", async () => {
    const { directory, files } = await checkout({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, ["tests/a.test.ts"])
    const quietBaseline = files.map((file) => ({ ...file, durationMs: 1000, loadFactor: 1 }))
    const slow = "if (flag) { const end = Date.now() + 7000; while (Date.now() < end) {} return 1 }"

    const run = await runMutants(directory, quietBaseline, [{ path: "lib/a.ts", mutant: mutantAt(PICK, "if (flag) return 1", slow, 2) }], undefined, () => 8)

    assert.deepEqual(run.results[0]?.verdict, { outcome: "survived", ran: ["tests/a.test.ts"] })
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

describe("mutantTimeoutSeconds", { skip: typescriptInstalled ? false : "typescript is not installed; run npm ci" }, () => {
  it("mutantTimeoutSeconds_isOneAndAHalfBaselineDurationsPlus5s_stretchedByHowMuchBusierTheHostIsNow", () => {
    assert.equal(mutantTimeoutSeconds(2000, 1, 1), 8)
    assert.equal(mutantTimeoutSeconds(2000, 1, 4), 17)
    assert.equal(mutantTimeoutSeconds(2000, 2, 4), 11)
  })

  it("mutantTimeoutSeconds_neverShrinks_whenTheHostIsQuieterThanDuringTheBaselineFile", () => {
    assert.equal(mutantTimeoutSeconds(2000, 4, 1), 8)
  })
})
