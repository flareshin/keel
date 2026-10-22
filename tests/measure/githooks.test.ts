import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { GITHOOKS_DIR, MEASURE_DIR, MeasureSandbox, readText } from "./helpers.ts"

const argvStub = (log: string): string => `#!/bin/bash\necho "$@" >> "${log}"\necho '{"scanned":0,"hits":[]}'\n`

describe("githooks", () => {
  let box: MeasureSandbox
  let repo: string
  let remote: string

  beforeEach(() => {
    box = new MeasureSandbox()
    box.writeLexicon()
    repo = path.join(box.root, "work")
    remote = path.join(box.root, "remote.git")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q", "--bare", remote], { env: box.env })
    box.initRepo(repo, remote)
    box.git(repo, "config", "core.hooksPath", GITHOOKS_DIR)
    box.env["KEEL_BOUNDARY"] = path.join(MEASURE_DIR, "boundary.ts")
  })
  afterEach(() => box.cleanup())

  const gitResult = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: box.env })

  function stage(name: string, content: string): void {
    box.write("work/" + name, content)
    box.git(repo, "add", name)
  }

  function useArgvStub(): string {
    const log = path.join(box.root, "boundary-argv.log")
    box.env["KEEL_BOUNDARY"] = box.write("stubs/boundary", argvStub(log), true)
    return log
  }

  it("preCommit_blocksTheCommit_whenStagedLinesHitTheLexicon", () => {
    stage("a.txt", "made for acmecorp\n")
    const completed = gitResult("commit", "-q", "-m", "Add a")
    assert.notEqual(completed.status, 0)
    assert.ok(completed.stderr.includes("pre-commit: commit blocked by the public-boundary scan (exit 1"))
    assert.ok(completed.stderr.includes("a.txt:1 matches lexicon:1"))
    assert.notEqual(gitResult("rev-parse", "--verify", "-q", "HEAD").status, 0)
  })

  it("preCommit_allowsTheCommit_whenStagedLinesAreClean", () => {
    stage("a.txt", "public text\n")
    const completed = gitResult("commit", "-q", "-m", "Add a")
    assert.equal(completed.status, 0, completed.stderr)
  })

  it("preCommit_blocksTheCommit_whenTheOverlayLexiconIsMissing", () => {
    fs.rmSync(path.join(box.overlay, "boundary", "lexicon.txt"))
    stage("a.txt", "public text\n")
    const completed = gitResult("commit", "-q", "-m", "Add a")
    assert.notEqual(completed.status, 0)
    assert.ok(completed.stderr.includes("overlay lexicon missing"))
  })

  it("preCommit_blocksTheCommit_whenTheOverlayLexiconIsEmpty", () => {
    box.write("overlay/boundary/lexicon.txt", "")
    stage("a.txt", "public text\n")
    const completed = gitResult("commit", "-q", "-m", "Add a")
    assert.notEqual(completed.status, 0)
    assert.ok(completed.stderr.includes("overlay lexicon has no terms"))
    assert.notEqual(gitResult("rev-parse", "--verify", "-q", "HEAD").status, 0)
  })

  it("preCommit_findsTheScannerBesideItself_whenNoOverrideIsSet", () => {
    delete box.env["KEEL_HOME"]
    delete box.env["KEEL_BOUNDARY"]
    stage("a.txt", "see TKT-1234\n")
    const completed = gitResult("commit", "-q", "-m", "Add a")
    assert.notEqual(completed.status, 0)
    assert.ok(completed.stderr.includes("matches lexicon:2"))
  })

  it("preCommit_passesStagedFlag_toTheScanner", () => {
    const log = useArgvStub()
    stage("a.txt", "x\n")
    gitResult("commit", "-q", "-m", "Add a")
    assert.equal(readText(log), "--staged\n")
  })

  it("prePush_blocksThePush_whenACommitMessageHitsTheLexicon", () => {
    box.write("work/a.txt", "public\n")
    box.commitAll(repo, "Fix TKT-4321")
    const completed = gitResult("push", "-q", "origin", "HEAD:refs/heads/main")
    assert.notEqual(completed.status, 0)
    assert.ok(completed.stderr.includes("pre-push: pushed commits hit the public boundary"))
    assert.equal(box.git(remote, "for-each-ref"), "")
  })

  it("prePush_allowsThePush_whenPushedCommitsAreClean", () => {
    box.write("work/a.txt", "public\n")
    box.commitAll(repo, "Add a")
    const completed = gitResult("push", "-q", "origin", "HEAD:refs/heads/main")
    assert.equal(completed.status, 0, completed.stderr)
  })

  it("prePush_scansOnlyNewCommits_whenTheBranchExistsRemotely", () => {
    box.write("work/a.txt", "public\n")
    const first = box.commitAll(repo, "Add a")
    gitResult("push", "-q", "origin", "HEAD:refs/heads/main")
    box.write("work/a.txt", "public\nmore\n")
    const second = box.commitAll(repo, "Add more")
    const log = useArgvStub()
    const completed = gitResult("push", "-q", "origin", "HEAD:refs/heads/main")
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(readText(log), `--range ${first}..${second}\n`)
  })

  it("prePush_skipsTheScanner_whenOnlyDeletingABranch", () => {
    box.write("work/a.txt", "public\n")
    box.commitAll(repo, "Add a")
    gitResult("push", "-q", "origin", "HEAD:refs/heads/topic")
    const log = useArgvStub()
    const completed = gitResult("push", "-q", "origin", ":refs/heads/topic")
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(fs.existsSync(log), false)
  })
})
