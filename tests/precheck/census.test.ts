import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { after, afterEach, beforeEach, describe, it } from "node:test"
import { snapshotTree } from "../../lib/evidence/gitcmd.ts"
import * as cli from "../../lib/evidence/cli.ts"
import { committedRepo, writeFiles } from "./fixture.ts"

const typescriptInstalled = await import("typescript").then(() => true, () => false)
type CensusModule = typeof import("../../lib/precheck/census.ts")
const { runCensus } = typescriptInstalled ? await import("../../lib/precheck/census.ts") : ({} as CensusModule)

const KEEL = join(import.meta.dirname, "..", "..", "bin", "keel")
const PICK = "export function pick(flag: boolean): number {\n  return 0\n}\n"
const PICK_TEST = "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\nit('picks', () => assert.equal(pick(true), 1))\n"
const CHANGED_PICK = "export function pick(flag: boolean): number {\n  if (flag) return 1\n  return 2\n}\n"

describe("runCensus", { skip: typescriptInstalled ? false : "typescript is not installed; run npm ci" }, () => {
  const roots: string[] = []
  let scratch = ""
  let savedTmpdir: string | undefined
  after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
  beforeEach(() => {
    savedTmpdir = process.env["TMPDIR"]
    scratch = mkdtempSync(join(tmpdir(), "census-scratch-"))
    process.env["TMPDIR"] = scratch
  })
  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env["TMPDIR"]
    else process.env["TMPDIR"] = savedTmpdir
    rmSync(scratch, { recursive: true, force: true })
  })
  const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  const changedRepo = (base: Record<string, string>, changed: Record<string, string>): { root: string; reviewBase: string; tree: string } => {
    const root = committedRepo(base)
    roots.push(root)
    writeFiles(root, changed)
    return { root, reviewBase: git(root, "rev-parse", "HEAD"), tree: snapshotTree(root) }
  }
  const census = async (base: Record<string, string>, changed: Record<string, string>) => {
    const { root, reviewBase, tree } = changedRepo(base, changed)
    return { root, tree, census: await runCensus(root, { base: "main", reviewBase, tree }) }
  }

  it("runCensus_runsTheChangedLinesMutantsAgainstTheBaseline_andRecordsTheNonTestBlobs", async () => {
    const { root, tree, census: result } = await census({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, { "lib/a.ts": CHANGED_PICK })

    assert.equal(result.tree, tree)
    assert.equal(result.base, "main")
    assert.deepEqual(result.paths, { source: 1, test: 0 })
    assert.deepEqual(result.blobs, { "lib/a.ts": git(root, "rev-parse", `${tree}:lib/a.ts`) })
    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    assert.deepEqual([result.mutation.baselineFiles, result.mutation.baselinePasses, result.mutation.withoutPasses], [1, 1, 0])
    const verdicts = result.mutation.results.map((each) => `${each.line} ${each.operator} ${each.change} ${each.verdict.outcome}`)
    assert.ok(verdicts.includes("2 condition-negation flag → !(flag) killed"), verdicts.join("\n"))
    assert.ok(verdicts.includes("3 return-constant 2 → null no test reaches"), verdicts.join("\n"))
    assert.deepEqual(result.mutation.notRun, [])
    assert.deepEqual(result.consumers.map((name) => name.name), ["pick"])
  })

  it("runCensus_givesTheBaselineATimeoutScaledByHostLoad_whenTheLoadIsTwiceTheCpus", async () => {
    const { root, reviewBase, tree } = changedRepo({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, { "lib/a.ts": CHANGED_PICK })

    const result = await runCensus(root, { base: "main", reviewBase, tree }, { load: 24, cpus: 12 })

    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    assert.equal(result.mutation.timeoutSeconds, 600)
  })

  it("runCensus_recordsADeletedSourceFileAsZeros_withoutMutatingIt", async () => {
    const { root, reviewBase } = changedRepo({ "lib/a.ts": PICK, "lib/old.ts": "export const old = 1\n", "tests/a.test.ts": PICK_TEST }, { "lib/a.ts": CHANGED_PICK })
    git(root, "rm", "-q", "lib/old.ts")

    const result = await runCensus(root, { base: "main", reviewBase, tree: snapshotTree(root) })

    assert.equal(result.blobs["lib/old.ts"], "0".repeat(40))
    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    assert.ok(result.mutation.results.every((each) => each.path === "lib/a.ts"))
  })

  it("runCensus_runsHigherPriorityMutantsFirst_acrossChangedFiles", async () => {
    const { census: result } = await census(
      { "lib/a.ts": PICK, "lib/b.ts": "export const b = (x: number): number => x\n", "tests/a.test.ts": PICK_TEST },
      { "lib/a.ts": CHANGED_PICK, "lib/b.ts": "export function b(x: number): boolean {\n  return x > 1\n}\n" },
    )

    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    const operators = result.mutation.results.map((each) => each.operator)
    assert.ok(operators.indexOf("boundary") < operators.indexOf("return-constant"), operators.join(","))
    assert.ok(operators.indexOf("condition-negation") < operators.indexOf("boundary"), operators.join(","))
  })

  it("runCensus_stopsAtARedBaseline_withoutMutants_andRemovesTheCheckout", async () => {
    const { census: result } = await census(
      { "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST },
      { "lib/a.ts": "export function pick(flag: boolean): number {\n  return 3\n}\n" },
    )

    assert.equal(result.mutation.outcome, "stopped")
    if (result.mutation.outcome !== "stopped") return
    assert.equal(result.mutation.baseline.outcome, "red")
    assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith("keel-precheck-")), [])
  })

  it("runCensus_removesTheCheckout_afterARun", async () => {
    await census({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, { "lib/a.ts": CHANGED_PICK })

    assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith("keel-precheck-")), [])
  })

  it("runCensus_holdsAHookDiffToPriorityOneToThree_andListsTheRestAsNotRun", async () => {
    const hook = "export function gate(n: number): boolean {\n  return true\n}\n"
    const hookTest = "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { gate } from '../hooks/gate.ts'\nit('gates', () => assert.equal(gate(2), true))\n"
    const { census: result } = await census(
      { "hooks/gate.ts": hook, "tests/gate.test.ts": hookTest },
      { "hooks/gate.ts": "export function gate(n: number): boolean {\n  if (n > 1) return true\n  return false\n}\n" },
    )

    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    assert.deepEqual([...new Set(result.mutation.results.map((each) => each.operator))], ["condition-negation"])
    assert.deepEqual([...new Set(result.mutation.notRun.map((each) => each.operator))].sort(), ["boundary", "return-constant"])
  })

  it("runCensus_countsChangedTestPathsApartFromSourcePaths", async () => {
    const { census: result } = await census({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, { "lib/a.ts": CHANGED_PICK, "tests/a.test.ts": PICK_TEST + "// grown\n" })

    assert.deepEqual(result.paths, { source: 1, test: 1 })
  })

  it("runCensus_keepsSymlinksInTheBlobs_andMutatesOnlyRegularScriptFiles", async () => {
    const root = committedRepo({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST })
    roots.push(root)
    writeFiles(root, { "lib/a.ts": CHANGED_PICK })
    symlinkSync("lib", join(root, "linkdir"))
    symlinkSync("lib", join(root, "lib.js"))
    symlinkSync("../shared/x.ts", join(root, "lib", "x.ts"))
    const tree = snapshotTree(root)

    const result = await runCensus(root, { base: "main", reviewBase: git(root, "rev-parse", "HEAD"), tree })

    assert.deepEqual(Object.keys(result.blobs).sort(), ["lib.js", "lib/a.ts", "lib/x.ts", "linkdir"])
    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    assert.deepEqual([...new Set(result.mutation.results.map((each) => each.path))], ["lib/a.ts"])
  })

  it("runCensus_describesAChangeWithoutQuotingStringTemplateOrCommentText", async () => {
    const changed = [
      "export function pick(flag: boolean): number {",
      "  note(/* we fixed */ 'tests pass') // done",
      "  note(`${flag} works fine`)",
      "  note(String(/tests pass/.test('x')))",
      "  note(`${{ on: flag }.on} works ${flag} fine`)",
      "  note(String([flag, flag, flag, flag, flag, flag, flag, flag]))",
      "  note(String(flag! / 2) + 'tests pass')",
      "  let count = 0",
      "  note(String(count++ / 2) + 'works fine')",
      "  const help = 'Run it. Then stop.'",
      "  return help.length / 18",
      "}",
      "function note(text: string): void {}",
      "",
    ].join("\n")

    const { census: result } = await census({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST }, { "lib/a.ts": changed })

    assert.equal(result.mutation.outcome, "ran")
    if (result.mutation.outcome !== "ran") return
    const changes = result.mutation.results.map((each) => `${each.line} ${each.operator} ${each.change}`)
    assert.ok(changes.includes("2 call-removal note( '…') removed"), changes.join("\n"))
    assert.ok(changes.includes("3 call-removal note('…'flag'…') removed"), changes.join("\n"))
    assert.ok(changes.includes("4 call-removal note(String(/…/.test('…'))) removed"), changes.join("\n"))
    assert.ok(changes.includes("5 call-removal note('…'{ on: flag }.on'…'flag'…') removed"), changes.join("\n"))
    assert.ok(changes.includes("6 call-removal note(String([flag, flag, flag, flag, fl… removed"), changes.join("\n"))
    assert.ok(changes.includes("7 call-removal note(String(flag! / 2) + '…') removed"), changes.join("\n"))
    assert.ok(changes.includes("9 call-removal note(String(count++ / 2) + '…') removed"), changes.join("\n"))
    assert.ok(changes.includes("10 text-removal text removed"), changes.join("\n"))
    assert.ok(changes.includes("11 return-constant help.length / 18 → null"), changes.join("\n"))
    assert.doesNotMatch(changes.join("\n"), /tests pass|fixed|works|Run it/)
  })
})

describe("keel precheck run", { skip: typescriptInstalled ? false : "typescript is not installed; run npm ci" }, () => {
  const roots: string[] = []
  after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
  const keel = (args: string[], dataDir: string) => spawnSync(KEEL, ["precheck", "run", ...args], { encoding: "utf8", env: { ...process.env, KEEL_DATA_DIR: dataDir } })
  const scratchDir = (prefix: string): string => {
    const directory = mkdtempSync(join(tmpdir(), prefix))
    roots.push(directory)
    return directory
  }

  it("keelPrecheckRun_printsTheCensusAgainstTheMergeBase_andLogsOneLine", () => {
    const root = committedRepo({ "lib/a.ts": PICK, "tests/a.test.ts": PICK_TEST })
    roots.push(root)
    execFileSync("git", ["-C", root, "branch", "-q", "trunk"])
    execFileSync("git", ["-C", root, "checkout", "-q", "-b", "topic"])
    writeFiles(root, { "lib/a.ts": CHANGED_PICK })
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "topic"])
    execFileSync("git", ["-C", root, "checkout", "-q", "trunk"])
    writeFiles(root, { "lib/other.ts": "export const other = 1\n" })
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "main moved"])
    execFileSync("git", ["-C", root, "checkout", "-q", "topic"])
    const dataDir = scratchDir("keel-data-")

    const completed = keel(["--repo", root, "--base", "trunk"], dataDir)

    assert.equal(completed.status, 0, completed.stderr)
    const tree = snapshotTree(root)
    assert.match(completed.stdout, new RegExp(`^precheck tree ${tree} · base trunk · 1 paths \\(1 source, 0 test\\) · census \\(all candidates ran\\)\\nblobs     lib/a\\.ts [0-9a-f]{40}\\n`))
    const logged = readFileSync(join(dataDir, "logs", "keel-precheck.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(logged.length, 1)
    assert.equal(logged[0].tree, tree)
    assert.equal(logged[0].repo, root)
    assert.equal(logged[0].outcome, "census")
    assert.equal(logged[0].review_base, execFileSync("git", ["-C", root, "merge-base", "trunk", "HEAD"], { encoding: "utf8" }).trim())
  })

  it("keelPrecheckRun_rejectsMissingOrDashedOptions_andABaseWithoutAMergeBase", () => {
    const root = committedRepo({ "lib/a.ts": PICK })
    roots.push(root)
    const dataDir = scratchDir("keel-data-")

    assert.equal(keel(["--repo", root], dataDir).status, 2)
    assert.equal(keel(["--repo", root, "--base", "-x"], dataDir).status, 2)
    const unknownBase = keel(["--repo", root, "--base", "no-such-ref"], dataDir)
    assert.equal(unknownBase.status, 3)
    assert.match(unknownBase.stderr, /no-such-ref has no merge base with HEAD/)
  })

  it("keelPrecheckRun_refusesWithTheNpmCiHint_fromACheckoutWithoutNodeModules", () => {
    const root = committedRepo({ "lib/a.ts": PICK })
    roots.push(root)
    const checkout = scratchDir("keel-checkout-")
    const keelRoot = join(import.meta.dirname, "..", "..")
    cpSync(keelRoot, checkout, { recursive: true, filter: (source) => !["node_modules", ".git"].includes(basename(source)) })

    const completed = spawnSync(join(checkout, "bin", "keel"), ["precheck", "run", "--repo", root, "--base", "HEAD"], { encoding: "utf8", env: { ...process.env, KEEL_DATA_DIR: scratchDir("keel-data-") } })

    assert.equal(completed.status, 3, completed.stderr)
    assert.match(completed.stderr, /keel precheck run needs typescript; run npm ci in the keel checkout/)
  })

  it("typescriptResolves_answersFalseOnlyForAModuleNotFound_andRethrowsOtherResolveErrors", (t) => {
    const resolveFailure = (code: string) => () => {
      throw Object.assign(new Error("resolve failed"), { code })
    }

    assert.equal(cli.seams.typescriptResolves(), true)
    t.mock.method(cli.seams, "resolveTypescript", resolveFailure("ERR_MODULE_NOT_FOUND"))
    assert.equal(cli.seams.typescriptResolves(), false)
    t.mock.method(cli.seams, "resolveTypescript", resolveFailure("EACCES"))
    assert.throws(() => cli.seams.typescriptResolves(), /resolve failed/)
  })

  it("keelPrecheckRun_refusesALoadFailureWhenTypescriptDoesNotResolve_andTreatsItAsInternalOtherwise", async (t) => {
    const root = committedRepo({ "lib/a.ts": PICK })
    roots.push(root)
    const statusWhenLoadingFails = async (resolves: boolean): Promise<number> => {
      t.mock.method(cli.seams, "loadCensus", () => Promise.reject(new Error("load failed")))
      t.mock.method(cli.seams, "typescriptResolves", () => resolves)
      return cli.main(["precheck", "run", "--repo", root, "--base", "HEAD"])
    }

    assert.equal(await statusWhenLoadingFails(false), 3)
    assert.equal(await statusWhenLoadingFails(true), 70)
  })
})
