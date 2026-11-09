import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { changedScripts } from "../../lib/precheck/census.ts"
import { snapshotTree } from "../../lib/evidence/gitcmd.ts"
import { censusBeforeRerun, openMutantLines, rerunSurvivors } from "../../lib/precheck/rerun.ts"
import { committedRepo, writeFiles } from "./fixture.ts"

const KEEL = join(import.meta.dirname, "..", "..", "bin", "keel")
const BASE_PICK = "export function pick(flag: boolean): number {\n  return 0\n}\n"
const PICK = "export function pick(flag: boolean): number {\n  if (flag) return 1\n  return 2\n}\n"
const testOf = (flag: boolean, expected: number): string => `import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\nit('picks', () => assert.equal(pick(${flag}), ${expected}))\n`
const RERUN_LINE = /^rerun: survivors · \d+ killed/mu
const RERUN_COUNTS = /^rerun: survivors · (.*?) · tree /mu

describe("censusBeforeRerun", () => {
  it("censusBeforeRerun_dropsAnEarlierRerunBlock_soASecondRerunReplacesIt", () => {
    assert.equal(censusBeforeRerun("precheck tree a\nblobs     none\nrerun: survivors · 1 killed\nstill survived\n  x\n"), "precheck tree a\nblobs     none")
  })

  it("censusBeforeRerun_keepsACensusWithoutARerun", () => {
    assert.equal(censusBeforeRerun("precheck tree a\nblobs     none\n"), "precheck tree a\nblobs     none")
  })
})

describe("openMutantLines", () => {
  it("openMutantLines_readsTheSurvivedAndUnreachedSections_andNoOther", () => {
    const census = ["precheck tree a", "survived", "  a.ts:1  x  y  ran: t", "timeout", "  a.ts:2  x  y  test: t", "no test reaches", "  a.ts:3  x  y", "not run", "  a.ts:4  x  y", "consumers 0"].join("\n")

    assert.deepEqual(openMutantLines(census), ["  a.ts:1  x  y  ran: t", "  a.ts:3  x  y"])
  })

  it("openMutantLines_endsASectionAtTheEndOfTheText", () => {
    assert.deepEqual(openMutantLines("survived\n  a.ts:1  x  y"), ["  a.ts:1  x  y"])
  })
})

describe("keel precheck rerun", () => {
  const directories: string[] = []
  after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
  const scratch = mkdtempSync(join(tmpdir(), "keel-rerun-data-"))
  directories.push(scratch)
  const keel = (subcommand: string, root: string, ...rest: string[]) => spawnSync(KEEL, ["precheck", subcommand, "--repo", root, "--base", "trunk", ...rest], { encoding: "utf8", maxBuffer: Infinity, env: { ...process.env, KEEL_DATA_DIR: scratch } })
  const censusedRepo = (firstTest = testOf(true, 1), source = PICK): { root: string; censusFile: string; census: string } => {
    const root = committedRepo({ "lib/a.ts": BASE_PICK, "tests/a.test.ts": testOf(true, 0) })
    directories.push(root)
    execFileSync("git", ["-C", root, "branch", "-q", "trunk"])
    writeFiles(root, { "lib/a.ts": source, "tests/a.test.ts": firstTest })
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "topic"])
    const run = keel("run", root)
    assert.equal(run.status, 0, run.stderr)
    const censusFile = join(mkdtempSync(join(scratch, "census-")), "census.txt")
    writeFileSync(censusFile, run.stdout)
    return { root, censusFile, census: run.stdout }
  }

  it("rerun_killsAnOpenMutantWithTheAddedTest_andPrintsTheCensusAndTheResultLensReviewRecognizes", () => {
    const { root, censusFile, census } = censusedRepo()
    assert.match(census, /no test reaches\n {2}lib\/a\.ts:3/u)
    writeFiles(root, { "tests/b.test.ts": testOf(false, 2) })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 0, rerun.stderr)
    assert.ok(rerun.stdout.startsWith(census.trimEnd() + "\nrerun: survivors · "), rerun.stdout)
    assert.match(rerun.stdout, RERUN_LINE)
    assert.match(rerun.stdout, /^rerun: survivors · [1-9]\d* killed · 0 survived · 0 no test reaches/mu)
    assert.match(rerun.stdout, /ran tests\/b\.test\.ts$/mu)
    assert.doesNotMatch(rerun.stdout, /^still /mu)
  })

  const LONG_TERM = "aConditionNameThatIsLongerThanFortyCharactersLong"
  const TEST_HEADER = "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\n"
  const chainedTerms: Array<{ name: string; parameters: string; terms: string; first: string[]; added: string }> = [
    { name: "IdentifierTerms", parameters: "b: boolean, c: boolean", terms: "b && c", first: ["pick(true, true, true), 1", "pick(true, false, true), 2"], added: "pick(true, true, false), 2" },
    { name: "TermsThatDifferOnlyInsideAStringLiteral", parameters: "s: string", terms: "s.includes('b') && s.includes('c')", first: ["pick(true, 'bc'), 1", "pick(true, 'c'), 2"], added: "pick(true, 'b'), 2" },
    { name: "ARepeatedTerm", parameters: "b: boolean", terms: "b && b", first: ["pick(true, true), 1"], added: "pick(true, false), 2" },
  ]
  for (const { name, parameters, terms, first, added } of chainedTerms) {
    it(`rerun_runsEachOpenMutantOnce_withChainedLogicTermsOf${name}`, () => {
      const source = `export function pick(${LONG_TERM}: boolean, ${parameters}): number {\n  if (${LONG_TERM} && ${terms}) return 1\n  return 2\n}\n`
      const firstTest = `${TEST_HEADER}it('picks', () => { ${first.map((call) => `assert.equal(${call})`).join("; ")} })\n`
      const { root, censusFile, census } = censusedRepo(firstTest, source)
      const open = openMutantLines(census)
      writeFiles(root, { "tests/b.test.ts": `${TEST_HEADER}it('adds', () => assert.equal(${added}))\n` })

      const rerun = keel("rerun", root, "--census", censusFile)

      assert.equal(rerun.status, 0, rerun.stderr)
      assert.equal(new Set(open).size, open.length, open.join("\n"))
      const counts = [...(RERUN_COUNTS.exec(rerun.stdout)?.[1] ?? "").matchAll(/\d+/gu)].map(([count]) => Number(count))
      assert.equal(counts.reduce((sum, count) => sum + count, 0), open.length, rerun.stdout)
    })
  }

  it("rerun_killsASurvivedMutantWithTheAddedTest", () => {
    const loose = testOf(true, 1).replace("assert.equal(pick(true), 1)", "assert.ok(pick(true) > 0)")
    const { root, censusFile, census } = censusedRepo(loose)
    assert.match(census, /^survived\n {2}lib\/a\.ts:2:\d+ .*ran: tests\/a\.test\.ts/mu)
    writeFiles(root, { "tests/b.test.ts": testOf(true, 1) + testOf(false, 2).replace(/^import.*\n/gmu, "").replace("'picks'", "'picks false'") })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 0, rerun.stderr)
    assert.doesNotMatch(rerun.stdout, /^still /mu)
  })

  it("changedScripts_leavesOutAChangedFileThatIsNotAScript", () => {
    const root = committedRepo({ "lib/a.ts": BASE_PICK, "notes.md": "before\n" })
    directories.push(root)
    execFileSync("git", ["-C", root, "branch", "-q", "trunk"])
    writeFiles(root, { "lib/a.ts": PICK, "notes.md": "after\n" })
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "topic"])

    assert.deepEqual(changedScripts(root, "trunk", "HEAD", { "lib/a.ts": "x", "notes.md": "y" }), ["lib/a.ts"])
  })

  it("rerun_namesASurvivorTheAddedTestReachesButDoesNotKill", () => {
    const loose = testOf(true, 1).replace("assert.equal(pick(true), 1)", "assert.ok(pick(true) > 0)")
    const { root, censusFile } = censusedRepo(loose)
    writeFiles(root, { "tests/b.test.ts": loose })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 0, rerun.stderr)
    assert.match(rerun.stdout, /^still survived\n {2}lib\/a\.ts:2:\d+ .*ran: tests\/b\.test\.ts/mu)
  })

  it("rerun_logsItsTree_soAReviewOfThatTreeCountsAsPrechecked", () => {
    const { root, censusFile } = censusedRepo()
    const dataDir = mkdtempSync(join(scratch, "data-"))
    writeFiles(root, { "tests/b.test.ts": testOf(false, 2) })

    const rerun = spawnSync(KEEL, ["precheck", "rerun", "--repo", root, "--base", "trunk", "--census", censusFile], { encoding: "utf8", maxBuffer: Infinity, env: { ...process.env, KEEL_DATA_DIR: dataDir } })

    assert.equal(rerun.status, 0, rerun.stderr)
    const [record] = readFileSync(join(dataDir, "logs", "keel-precheck.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(record.tree, /tree ([0-9a-f]{40}) · ran /u.exec(rerun.stdout)?.[1])
    assert.equal(record.outcome, "rerun")
    assert.equal(record.repo, root)
    assert.deepEqual(record.tests, ["tests/b.test.ts"])
  })

  it("rerun_logsNothing_whenItRefuses", () => {
    const { root, censusFile } = censusedRepo()
    const dataDir = mkdtempSync(join(scratch, "data-"))

    const rerun = spawnSync(KEEL, ["precheck", "rerun", "--repo", root, "--base", "trunk", "--census", censusFile], { encoding: "utf8", maxBuffer: Infinity, env: { ...process.env, KEEL_DATA_DIR: dataDir } })

    assert.equal(rerun.status, 3, rerun.stdout)
    assert.equal(existsSync(join(dataDir, "logs", "keel-precheck.jsonl")), false)
  })

  it("rerunSurvivors_listsOnlyTheTestsTheBudgetStarted_andLeavesAnUnreachedMutantNotRun", async () => {
    const { root, census } = censusedRepo()
    writeFiles(root, { "tests/b.test.ts": testOf(true, 1), "tests/c.test.ts": testOf(false, 2) })
    const reviewBase = execFileSync("git", ["-C", root, "merge-base", "trunk", "HEAD"], { encoding: "utf8" }).trim()

    const rerun = await rerunSurvivors(root, { base: "trunk", reviewBase, tree: snapshotTree(root) }, census, 0)

    assert.deepEqual(rerun.tests, ["tests/b.test.ts"])
    assert.deepEqual(rerun.baselineNotRun, ["tests/c.test.ts"])
    assert.deepEqual(rerun.results.filter((result) => result.verdict.outcome === "no test reaches"), [])
    assert.ok(rerun.notRun.some((mutant) => mutant.line === 3), JSON.stringify(rerun.notRun))
  })

  it("rerun_doesNotRepeatAMutantTheCensusKilled_whenAnotherOnTheSameLineHasTheSameChange", () => {
    const twoLiterals = "export function pick(flag: boolean): string[] {\n  return flag ? ['first', 'second'] : []\n}\n"
    const root = committedRepo({ "lib/a.ts": "export function pick(flag: boolean): string[] {\n  return []\n}\n", "tests/a.test.ts": "" })
    directories.push(root)
    execFileSync("git", ["-C", root, "branch", "-q", "trunk"])
    const testing = (body: string) => `import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { pick } from '../lib/a.ts'\nit('picks', () => { ${body} })\n`
    writeFiles(root, { "lib/a.ts": twoLiterals, "tests/a.test.ts": testing("assert.equal(pick(true)[0], 'first'); assert.deepEqual(pick(false), [])") })
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "topic"])
    const run = keel("run", root)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^ {2}lib\/a\.ts:2:\d+ {2}text-removal/mu)
    const censusFile = join(mkdtempSync(join(scratch, "census-")), "census.txt")
    writeFileSync(censusFile, run.stdout)
    writeFiles(root, { "tests/b.test.ts": testing("assert.equal(pick(true)[1], 'second')") })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 0, rerun.stderr)
    assert.doesNotMatch(rerun.stdout.slice(rerun.stdout.indexOf("rerun: survivors")), /text-removal/u)
  })

  it("rerun_leavesNoCheckoutBehind", () => {
    const { root, censusFile } = censusedRepo()
    const temporary = mkdtempSync(join(scratch, "tmp-"))
    writeFiles(root, { "tests/b.test.ts": testOf(false, 2) })

    const rerun = spawnSync(KEEL, ["precheck", "rerun", "--repo", root, "--base", "trunk", "--census", censusFile], { encoding: "utf8", maxBuffer: Infinity, env: { ...process.env, KEEL_DATA_DIR: scratch, TMPDIR: temporary } })

    assert.equal(rerun.status, 0, rerun.stderr)
    assert.deepEqual(readdirSync(temporary), [])
  })

  it("rerun_listsAMutantTheAddedTestDoesNotKill_asStillOpen", () => {
    const { root, censusFile } = censusedRepo()
    writeFiles(root, { "tests/b.test.ts": testOf(true, 1) })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 0, rerun.stderr)
    assert.match(rerun.stdout, /^still no test reaches\n {2}lib\/a\.ts:3/mu)
  })

  it("rerun_replacesAnEarlierResult_whenTheCensusFileAlreadyHoldsOne", () => {
    const { root, censusFile } = censusedRepo()
    writeFiles(root, { "tests/b.test.ts": testOf(true, 1) })
    const first = keel("rerun", root, "--census", censusFile)
    writeFileSync(censusFile, first.stdout)
    writeFiles(root, { "tests/b.test.ts": testOf(true, 1) + testOf(false, 2).replace(/^import.*\n/gmu, "").replace("'picks'", "'picks false'") })

    const second = keel("rerun", root, "--census", censusFile)

    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.stdout.match(/^rerun: survivors/gmu)?.length, 1)
    assert.doesNotMatch(second.stdout, /^still /mu)
  })

  const refusals: Array<[string, Record<string, string>, RegExp]> = [
    ["ASourceChanged", { "lib/a.ts": PICK + "export const more = 1\n", "tests/b.test.ts": testOf(false, 2) }, /lib\/a\.ts differs from the census blobs; run keel precheck run/u],
    ["AnExistingTestLineChanged", { "tests/a.test.ts": testOf(true, 1).replace("'picks'", "'renamed'") }, /existing test lines changed or were removed after the precheck; run keel precheck run/u],
    ["NoTestChanged", {}, /no runnable test changed since tree [0-9a-f]{40}; run keel precheck run/u],
    ["OnlyATestSupportFileChanged", { "tests/fixture.ts": "export const fixture = 1\n" }, /no runnable test changed since tree/u],
    ["TheAddedTestIsRed", { "tests/b.test.ts": testOf(false, 99) }, /red in tests\/b\.test\.ts/u],
  ]
  for (const [name, changes, message] of refusals) {
    it(`rerun_refusesWithoutAResultLine_when${name}`, () => {
      const { root, censusFile } = censusedRepo()
      writeFiles(root, changes)

      const rerun = keel("rerun", root, "--census", censusFile)

      assert.equal(rerun.status, 3, rerun.stdout)
      assert.match(rerun.stderr, message)
      assert.doesNotMatch(rerun.stdout, /rerun: survivors/u)
    })
  }

  it("rerun_refuses_whenTheCensusListsNoOpenMutant", () => {
    const { root, censusFile, census } = censusedRepo()
    writeFileSync(censusFile, census.replace(/^no test reaches\n( {2}.*\n)+/mu, "").replace(/^survived\n( {2}.*\n)+/mu, ""))
    writeFiles(root, { "tests/b.test.ts": testOf(false, 2) })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 3, rerun.stdout)
    assert.match(rerun.stderr, /lists no survived or no-test-reaches mutant/u)
  })

  it("rerun_refuses_whenALineMatchesNoMutant", () => {
    const { root, censusFile, census } = censusedRepo()
    writeFileSync(censusFile, census.replace(/^( {2}lib\/a\.ts:)3/mu, "$199"))
    writeFiles(root, { "tests/b.test.ts": testOf(false, 2) })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 3, rerun.stdout)
    assert.match(rerun.stderr, /no mutant matches "lib\/a\.ts:99/u)
  })

  const staleCensuses: Array<[string, (census: string) => string, RegExp]> = [
    ["HasNoPrecheckHeader", (census) => census.replace(/^precheck tree [0-9a-f]{40}/u, "something else"), /the first line is not "precheck tree <40-hex tree id>"/u],
    ["NamesATreeThatIsNotInTheRepo", (census) => census.replace(/^precheck tree [0-9a-f]{40}/u, `precheck tree ${"a".repeat(40)}`), /tree a{40} is not in /u],
    ["RecordsASourceThatIsNoLongerChanged", (census) => census.replace(/^blobs +.*$/mu, (line) => `${line} · lib/gone.ts ${"b".repeat(40)}`), /lib\/gone\.ts differs from the census blobs/u],
  ]
  for (const [name, stale, message] of staleCensuses) {
    it(`rerun_refuses_whenTheCensus${name}`, () => {
      const { root, censusFile, census } = censusedRepo()
      writeFileSync(censusFile, stale(census))
      writeFiles(root, { "tests/b.test.ts": testOf(false, 2) })

      const rerun = keel("rerun", root, "--census", censusFile)

      assert.equal(rerun.status, 3, rerun.stdout)
      assert.match(rerun.stderr, message)
    })
  }

  it("rerun_refusesATypeError_beforeRunningAnyTest", () => {
    const { root, censusFile } = censusedRepo()
    writeFiles(root, { "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: "esnext", module: "nodenext", allowImportingTsExtensions: true, skipLibCheck: true, types: [] }, include: ["lib"] }), "lib/b.ts": "export const broken: number = 'text'\n" })

    const rerun = keel("rerun", root, "--census", censusFile)

    assert.equal(rerun.status, 3, rerun.stdout)
    assert.match(rerun.stderr, /tsc --noEmit failed in /u)
  })

  it("rerun_refuses_whenTheBaseHasNoMergeBase", () => {
    const { root, censusFile } = censusedRepo()

    const rerun = spawnSync(KEEL, ["precheck", "rerun", "--repo", root, "--base", "no-such-ref", "--census", censusFile], { encoding: "utf8", env: { ...process.env, KEEL_DATA_DIR: scratch } })

    assert.equal(rerun.status, 3, rerun.stdout)
    assert.match(rerun.stderr, /no-such-ref has no merge base with HEAD/u)
  })

  it("rerun_printsItsUsage_outsideAGitRepository", () => {
    const outside = mkdtempSync(join(scratch, "outside-"))

    const rerun = spawnSync(KEEL, ["precheck", "rerun", "--repo", outside, "--base", "trunk", "--census", "c.txt"], { encoding: "utf8", env: { ...process.env, KEEL_DATA_DIR: scratch } })

    assert.equal(rerun.status, 2, rerun.stderr)
    assert.match(rerun.stderr, /is not inside a git repository/u)
  })

  it("rerun_refuses_whenTheCensusFileIsMissing", () => {
    const { root } = censusedRepo()

    const rerun = keel("rerun", root, "--census", join(scratch, "absent.txt"))

    assert.equal(rerun.status, 3)
    assert.match(rerun.stderr, /cannot read .*absent\.txt/u)
  })

  const usages: Array<[string, string[]]> = [
    ["TheCensusOption", ["--repo", scratch, "--base", "trunk"]],
    ["TheBaseOption", ["--repo", scratch, "--census", "c.txt"]],
    ["ABaseThatIsNotAnOption", ["--repo", scratch, "--base", "-x", "--census", "c.txt"]],
  ]
  for (const [name, args] of usages) {
    it(`rerun_printsItsUsage_without${name}`, () => {
      const rerun = spawnSync(KEEL, ["precheck", "rerun", ...args], { encoding: "utf8", env: { ...process.env, KEEL_DATA_DIR: scratch } })

      assert.equal(rerun.status, 2, rerun.stderr)
      assert.match(rerun.stderr, /^keel: keel precheck rerun --repo <path> --base <ref> --census <file>/u)
    })
  }
})
