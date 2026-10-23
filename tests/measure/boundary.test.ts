import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT, MeasureSandbox } from "./helpers.ts"

const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
const INVENTED_PRIVATE_IP = "10.250." + "3.4"
const TRACK_PATHS = ["ledger.tsv", "measure", "githooks", "tests/measure", "examples/ledger-smoke"]

function sortedHits(hits: { line: number; rule: string }[]): string[] {
  return hits.map((hit) => `${hit.line} ${hit.rule}`).sort()
}

describe("boundary", () => {
  let box: MeasureSandbox
  let repo: string

  beforeEach(() => {
    box = new MeasureSandbox()
    repo = path.join(box.root, "work")
    fs.mkdirSync(repo)
  })
  afterEach(() => box.cleanup())

  const scan = (...args: string[]) => box.runJson("boundary", args, repo)

  it("boundaryPaths_reportsLexiconRegexAndGenericHits_withLinesAndRuleNames", () => {
    box.writeLexicon()
    box.write("work/notes.txt", `clean line\nshipped for acmecorp\nsee TKT-1234\nhost ${INVENTED_PRIVATE_IP}\nkey ${FAKE_AWS_KEY}\n`)
    const [completed, result] = scan("--paths", "notes.txt")
    assert.equal(completed.status, 1)
    assert.deepEqual(sortedHits(result.hits), [
      "2 lexicon:1", "3 lexicon:2", "3 regex:1", "4 generic:private-ipv4-10", "4 regex:2", "5 generic:aws-access-key",
    ])
    assert.ok(!(completed.stdout + completed.stderr).includes("ACMECORP"))
  })

  it("boundaryPaths_passes_whenNothingMatches", () => {
    box.writeLexicon()
    box.write("work/notes.txt", "a public sentence\n")
    const [completed, result] = scan("--paths", "notes.txt")
    assert.deepEqual([completed.status, result.hits, result.scanned], [0, [], 2])
  })

  it("boundaryPaths_scansPathNames_asLineZero", () => {
    box.writeLexicon()
    box.write("work/acmecorp-notes.txt", "clean\n")
    const [, result] = scan("--paths", ".")
    assert.deepEqual(result.hits, [{ file: "acmecorp-notes.txt", line: 0, rule: "lexicon:1" }])
  })

  it("boundary_exitsTwo_whenOverlayLexiconIsMissing", () => {
    box.write("work/notes.txt", "clean\n")
    const completed = box.runMeasure("boundary", ["--paths", "notes.txt"], repo)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("overlay lexicon missing"))
  })

  it("boundary_exitsTwo_whenOverlayLexiconHasNoTerms", () => {
    box.write("overlay/boundary/lexicon.txt", "# terms go here\n\n")
    box.write("work/notes.txt", "clean\n")
    const completed = box.runMeasure("boundary", ["--paths", "notes.txt"], repo)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("has no terms"))
  })

  it("boundary_usesGenericRulesOnly_whenGenericOnlyIsGiven", () => {
    box.write("work/notes.txt", `acmecorp\nkey ${FAKE_AWS_KEY}\n`)
    const [completed, result] = scan("--generic-only", "--paths", "notes.txt")
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits.map((hit: { rule: string }) => hit.rule), ["generic:aws-access-key"])
  })

  it("boundary_exitsTwo_whenOverlayRegexIsInvalid", () => {
    box.writeLexicon()
    box.write("overlay/boundary/regex.txt", "(unclosed\n")
    box.write("work/notes.txt", "clean\n")
    const completed = box.runMeasure("boundary", ["--paths", "notes.txt"], repo)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("regex:1"))
  })

  it("boundaryStaged_scansOnlyStagedAddedLines_withNewLineNumbers", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/app.txt", "one\ntwo\nthree\n")
    box.commitAll(repo)
    box.write("work/app.txt", "one\ntwo acmecorp\nthree\n++ TKT-9 header lookalike\n")
    box.git(repo, "add", "app.txt")
    box.write("work/unstaged.txt", "acmecorp but not staged\n")
    const [completed, result] = scan("--staged")
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits, [
      { file: "app.txt", line: 2, rule: "lexicon:1" },
      { file: "app.txt", line: 4, rule: "lexicon:2" },
    ])
  })

  it("boundaryStaged_passes_whenStagedLinesAreClean", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/app.txt", "clean\n")
    box.git(repo, "add", "app.txt")
    const [completed, result] = scan("--staged")
    assert.deepEqual([completed.status, result.hits], [0, []])
  })

  it("boundaryStaged_reportsTheName_whenAStagedFileIsBinary", () => {
    box.writeLexicon()
    box.initRepo(repo)
    fs.writeFileSync(path.join(repo, "acmecorp.bin"), Buffer.from([0, 1, 2]))
    box.git(repo, "add", "acmecorp.bin")
    const [completed, result] = scan("--staged")
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits, [{ file: "acmecorp.bin", line: 0, rule: "lexicon:1" }])
  })

  it("boundaryStaged_reportsTheName_whenAStagedFileIsEmpty", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/acmecorp-empty.txt", "")
    box.git(repo, "add", "acmecorp-empty.txt")
    const [completed, result] = scan("--staged")
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits, [{ file: "acmecorp-empty.txt", line: 0, rule: "lexicon:1" }])
  })

  it("boundaryRange_reportsTheName_whenACommitAddsAnEmptyFile", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/a.txt", "base\n")
    const base = box.commitAll(repo, "Base")
    box.write("work/acmecorp-empty.txt", "")
    const head = box.commitAll(repo, "Add a file")
    const [completed, result] = scan("--range", `${base}..${head}`)
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits.map((hit: { file: string; line: number }) => [hit.file.split(":")[1], hit.line]), [["acmecorp-empty.txt", 0]])
  })

  it("boundaryStaged_skipsTheName_whenAStagedChangeDeletesTheFile", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/acmecorp-old.txt", "clean\n")
    box.git(repo, "add", "-A")
    box.git(repo, "commit", "-q", "--no-verify", "-m", "Base")
    box.git(repo, "rm", "-q", "acmecorp-old.txt")
    const [completed, result] = scan("--staged")
    assert.deepEqual([completed.status, result.hits], [0, []])
  })

  it("boundaryPaths_scansOnlyTrackedFiles_whenTheDirectoryIsALinkedWorktree", () => {
    box.writeLexicon()
    const main = path.join(box.root, "main")
    fs.mkdirSync(main)
    box.initRepo(main)
    box.write("main/tracked.txt", "one\ntwo\n")
    box.write("main/.gitignore", "*.log\n")
    box.commitAll(main)
    const worktree = path.join(box.root, "acmecorp-wt")
    box.git(main, "worktree", "add", "-q", worktree)
    box.write("acmecorp-wt/untracked.txt", "acmecorp\n")
    box.write("acmecorp-wt/build.log", "acmecorp\n")
    const [completed, result] = box.runJson("boundary", ["--paths", "."], worktree)
    assert.equal(completed.status, 0, JSON.stringify(result))
    assert.equal(result.scanned, 2 + 3)
  })

  it("boundaryPaths_exitsTwo_whenADirectoryHoldsOnlyUntrackedFiles", () => {
    box.writeLexicon()
    const other = path.join(box.root, "repo")
    fs.mkdirSync(other)
    box.initRepo(other)
    box.write("repo/tracked.txt", "one\n")
    box.commitAll(other)
    box.write("repo/newskill/SKILL.md", "draft\n")
    const [completed] = box.runJson("boundary", ["--paths", "newskill"], other)
    assert.equal(completed.status, 2)
    assert.ok(completed.stderr.includes("newskill"))
  })

  function makeParentWithSubmodule(): string {
    const sub = path.join(box.root, "sub")
    const parent = path.join(box.root, "parent")
    fs.mkdirSync(sub)
    fs.mkdirSync(parent)
    box.initRepo(sub)
    box.write("sub/s.txt", "acmecorp\n")
    box.commitAll(sub)
    box.initRepo(parent)
    box.write("parent/p.txt", "one\n")
    box.git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mysub")
    box.commitAll(parent)
    return parent
  }

  it("boundaryPaths_skipsTheGitlink_whenTheSubmoduleIsUninitialized", () => {
    box.writeLexicon()
    const parent = makeParentWithSubmodule()
    const clone = path.join(box.root, "clone")
    box.git(box.root, "clone", "-q", parent, clone)
    const [whole, wholeResult] = box.runJson("boundary", ["--paths", "."], clone)
    const [gitlink, gitlinkResult] = box.runJson("boundary", ["--paths", "mysub"], clone)
    assert.equal(whole.status, 0, whole.stderr)
    assert.deepEqual(wholeResult.hits, [])
    assert.deepEqual([gitlink.status, gitlinkResult], [0, { scanned: 0, hits: [] }], gitlink.stderr)
  })

  it("boundaryPaths_scansSubmoduleFiles_whenTheSubmoduleIsInitialized", () => {
    box.writeLexicon()
    const parent = makeParentWithSubmodule()
    const [completed, result] = box.runJson("boundary", ["--paths", "."], parent)
    assert.equal(completed.status, 1, completed.stderr)
    assert.deepEqual(result.hits.map((hit: { file: string }) => hit.file), ["mysub/s.txt"])
  })

  it("boundaryPaths_skipsGitInternals_whenTheDirectoryIsOutsideAWorkTree", () => {
    box.writeLexicon()
    box.write("work/notes.txt", "clean\n")
    box.write("work/.git", "gitdir: /somewhere/acmecorp/.git/worktrees/x\n")
    box.write("work/sub/.git/config", "[remote] acmecorp\n")
    box.write("work/sub/untracked.txt", "acmecorp\n")
    const [completed, result] = box.runJson("boundary", ["--paths", "work"], box.root)
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits.map((hit: { file: string }) => hit.file), ["work/sub/untracked.txt"])
  })

  it("boundaryRange_scansCommitMessagesAndAddedLines_perCommit", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/a.txt", "base\n")
    const base = box.commitAll(repo, "Base")
    box.write("work/a.txt", "base\nacmecorp\n")
    box.commitAll(repo, "Add a line")
    box.write("work/a.txt", "base\n")
    const head = box.commitAll(repo, "Fix TKT-4321")
    const [completed, result] = scan("--range", `${base}..${head}`)
    assert.equal(completed.status, 1)
    const found = result.hits.map((hit: { file: string; line: number; rule: string }) => `${hit.file.split(":")[1]} ${hit.line} ${hit.rule}`).sort()
    assert.deepEqual(found, ["a.txt 2 lexicon:1", "message 1 lexicon:2", "message 1 regex:1"])
  })

  it("boundaryRange_scansCommitsNotOnAnyRemote_whenOldIsZero", () => {
    box.writeLexicon()
    box.initRepo(repo)
    box.write("work/a.txt", "acmecorp in the root commit\n")
    const head = box.commitAll(repo, "Root")
    const [completed, result] = scan("--range", `${"0".repeat(40)}..${head}`)
    assert.equal(completed.status, 1)
    assert.deepEqual(result.hits.map((hit: { line: number; rule: string }) => [hit.line, hit.rule]), [[1, "lexicon:1"]])
  })

  it("boundaryRange_exitsTwo_whenRangeHasNoDots", () => {
    box.writeLexicon()
    box.initRepo(repo)
    const completed = box.runMeasure("boundary", ["--range", "HEAD"], repo)
    assert.equal(completed.status, 2)
  })

  it("boundaryGeneric_findsNothing_inThisTracksOwnFiles", () => {
    const paths = TRACK_PATHS.map((trackPath) => path.join(CHECKOUT, trackPath))
    const [completed, result] = box.runJson("boundary", ["--generic-only", "--paths", ...paths])
    assert.equal(completed.status, 0, result ? JSON.stringify(result.hits) : completed.stderr)
    assert.ok(result.scanned > 100)
  })

  it("boundary_exitsTwo_whenNoSourceOrMoreThanOneIsGiven", () => {
    box.write("work/notes.txt", "clean\n")
    const none = box.runMeasure("boundary", ["--generic-only"], repo)
    const both = box.runMeasure("boundary", ["--staged", "--paths", "notes.txt"], repo)
    assert.deepEqual([none.status, both.status], [2, 2])
    for (const usageError of [none, both]) {
      assert.ok(usageError.stderr.startsWith("usage: measure/boundary"), usageError.stderr)
      assert.ok(usageError.stderr.includes("exactly one of --staged, --range, --paths"), usageError.stderr)
    }
  })
})
