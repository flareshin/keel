import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { GitError, runGitOrThrow } from "../../measure/lib/measurekit/gitutil.ts"
import { FIXTURE_TEST_SECONDS, inDetachedWorktree, testFailure } from "../../measure/evals/lib/evalkit/fixturetests.ts"

describe("fixture test runs for eval graders", () => {
  let repo: string

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-repo"))
    runGitOrThrow(repo, ["init", "-q"])
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  const commit = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), text)
    runGitOrThrow(repo, ["add", "-A"])
    runGitOrThrow(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture"])
  }
  const nodeTestAtHead = (timeoutSeconds = FIXTURE_TEST_SECONDS) => inDetachedWorktree(repo, "HEAD", (tree) => testFailure(tree, [process.execPath, "--test"], timeoutSeconds))

  it("FIXTURE_TEST_SECONDS_isAFinitePositiveDeadline", () => {
    assert.ok(Number.isFinite(FIXTURE_TEST_SECONDS) && FIXTURE_TEST_SECONDS > 0)
  })

  it("testFailure_returnsNull_forAGreenSuite", async () => {
    commit({ "a.test.mjs": 'import { test } from "node:test"\ntest("passes", () => {})\n' })
    assert.equal(await nodeTestAtHead(), null)
  })

  it("testFailure_returnsTheFirstFailingTestWithoutItsDuration", async () => {
    commit({ "a.test.mjs": 'import { test } from "node:test"\ntest("fails here", () => { throw new Error("no") })\n' })
    assert.equal(await nodeTestAtHead(), "✖ fails here")
  })

  it("testFailure_namesTheCommandAndExit_whenNoTestFailureIsPrinted", async () => {
    commit({ "README.md": "fixture\n" })
    assert.equal(await inDetachedWorktree(repo, "HEAD", (tree) => testFailure(tree, [process.execPath, "-e", "process.exit(3)"], FIXTURE_TEST_SECONDS)), "node -e process.exit(3) exit 3")
  })

  it("testFailure_reportsATimeout_forASuiteThatNeverFinishes", async () => {
    commit({ "a.test.mjs": 'import { test } from "node:test"\ntest("spins", () => { while (true) {} })\n' })
    assert.equal(await nodeTestAtHead(2), "node --test timed out after 2s")
  })

  it("inDetachedWorktree_removesTheWorktree_afterUseThrows", async () => {
    commit({ "README.md": "fixture\n" })
    let seen = ""
    await assert.rejects(inDetachedWorktree(repo, "HEAD", async (tree) => {
      seen = tree
      throw new Error("use failed")
    }), /use failed/)
    assert.equal(fs.existsSync(path.dirname(seen)), false)
    assert.equal(runGitOrThrow(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length, 1)
  })

  it("inDetachedWorktree_keepsTheAddFailure_forAMissingRef", async () => {
    commit({ "README.md": "fixture\n" })
    await assert.rejects(inDetachedWorktree(repo, "no-such-ref", async () => null), (error: unknown) => error instanceof GitError && /no-such-ref/.test(String(error.message)))
  })
})
