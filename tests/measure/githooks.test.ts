import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { GITHOOKS_DIR, MeasureSandbox } from "./helpers.ts"

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
  })
  afterEach(() => box.cleanup())

  const gitResult = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: box.env })

  function stage(name: string, content: string): void {
    box.write("work/" + name, content)
    box.git(repo, "add", name)
  }

  function fakeKeelHome(): string {
    box.write("fake-keel/measure/boundary", "#!/bin/bash\nexit 0\n", true)
    return path.join(box.root, "fake-keel")
  }

  function removeLexicon(): void {
    fs.rmSync(path.join(box.overlay, "boundary", "lexicon.txt"))
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
    removeLexicon()
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

  it("preCommit_scansOnlyStagedLines_whenTheWorkTreeHoldsAnUnstagedHit", () => {
    stage("a.txt", "public text\n")
    box.write("work/a.txt", "made for acmecorp\n")
    const completed = gitResult("commit", "-q", "-m", "Add a")
    assert.equal(completed.status, 0, completed.stderr)
  })

  it("preCommit_runsTheScannerBesideItself_whenTheEnvironmentNamesAnotherOne", () => {
    stage("a.txt", "made for acmecorp\n")
    for (const override of [{ KEEL_BOUNDARY: "/usr/bin/true" }, { KEEL_HOME: fakeKeelHome() }]) {
      Object.assign(box.env, override)
      const completed = gitResult("commit", "-q", "-m", "Add a")
      assert.notEqual(completed.status, 0)
      assert.ok(completed.stderr.includes("a.txt:1 matches lexicon:1"), completed.stderr)
      delete box.env["KEEL_BOUNDARY"]
      box.env["KEEL_HOME"] = box.keel
    }
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

  it("prePush_runsTheScannerBesideItself_whenTheEnvironmentNamesAnotherOne", () => {
    box.write("work/a.txt", "public\n")
    box.commitAll(repo, "Fix TKT-4321")
    for (const override of [{ KEEL_BOUNDARY: "/usr/bin/true" }, { KEEL_HOME: fakeKeelHome() }]) {
      Object.assign(box.env, override)
      const completed = gitResult("push", "-q", "origin", "HEAD:refs/heads/main")
      assert.notEqual(completed.status, 0)
      assert.ok(completed.stderr.includes("pre-push: pushed commits hit the public boundary"), completed.stderr)
      delete box.env["KEEL_BOUNDARY"]
      box.env["KEEL_HOME"] = box.keel
    }
    assert.equal(box.git(remote, "for-each-ref"), "")
  })

  it("prePush_scansOnlyNewCommits_whenTheBranchExistsRemotely", () => {
    box.write("work/a.txt", "zebraword\n")
    box.commitAll(repo, "Add a")
    assert.equal(gitResult("push", "-q", "origin", "HEAD:refs/heads/main").status, 0)
    box.write("overlay/boundary/lexicon.txt", "ACMECORP\nTKT-\nZEBRAWORD\n")
    box.write("work/b.txt", "public\n")
    box.commitAll(repo, "Add b")
    const completed = gitResult("push", "-q", "origin", "HEAD:refs/heads/main")
    assert.equal(completed.status, 0, completed.stderr)
  })

  it("prePush_skipsTheScanner_whenOnlyDeletingABranch", () => {
    box.write("work/a.txt", "public\n")
    box.commitAll(repo, "Add a")
    gitResult("push", "-q", "origin", "HEAD:refs/heads/topic")
    removeLexicon()
    const completed = gitResult("push", "-q", "origin", ":refs/heads/topic")
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(box.git(remote, "for-each-ref"), "")
  })
})
