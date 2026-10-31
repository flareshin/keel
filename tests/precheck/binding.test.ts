import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { bindPrecheck, DELETED_BLOB, precheckRequirement, precheckTreeOf } from "../../lib/precheck/binding.ts"
import { committedRepo, writeFiles } from "./fixture.ts"

const KEEL = join(import.meta.dirname, "..", "..", "bin", "keel")
const TREE = "4f1c9e2a7b3d58e60c1f9a2b7d4e3c5a6b8d9e0f"

describe("bindPrecheck", () => {
  const roots: string[] = []
  after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
  const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  const repo = (files: Record<string, string>): string => {
    const root = committedRepo(files)
    roots.push(root)
    return root
  }
  const treeOf = (root: string, files: Record<string, string>): string => {
    writeFiles(root, files)
    git(root, "add", "-A")
    return git(root, "write-tree")
  }

  it("bindPrecheck_recordsEachChangedNonTestPathByItsRepoPath_withZerosForADeletedOne", () => {
    const root = repo({ "lib/a.ts": "a\n", "lib/gone.ts": "g\n", "tests/a.test.ts": "t\n" })
    const base = git(root, "rev-parse", "HEAD^{tree}")
    git(root, "rm", "-q", "lib/gone.ts")
    const end = treeOf(root, { "lib/a.ts": "a2\n", "lib/new.ts": "n\n", "tests/a.test.ts": "t2\n", "tests/helpers.ts": "h\n" })

    const binding = bindPrecheck(root, base, end, end)

    assert.deepEqual(binding.blobs, {
      "lib/a.ts": git(root, "rev-parse", `${end}:lib/a.ts`),
      "lib/gone.ts": DELETED_BLOB,
      "lib/new.ts": git(root, "rev-parse", `${end}:lib/new.ts`),
    })
  })

  it("bindPrecheck_reportsTestsAddedOnly_whenTestFilesOnlyGainLinesAfterThePrecheckTree", () => {
    const root = repo({ "lib/a.ts": "a\n", "tests/a.test.ts": "one\n" })
    const precheckTree = git(root, "rev-parse", "HEAD^{tree}")
    const end = treeOf(root, { "tests/a.test.ts": "one\ntwo\n", "tests/b.test.ts": "new\n" })

    assert.deepEqual(bindPrecheck(root, precheckTree, end, precheckTree).test_change, { lines_removed: false, lines_added: true })
  })

  it("bindPrecheck_reportsTestLinesRemoved_whenAnExistingTestLineChangesOrATestFileIsDeleted", () => {
    const changed = repo({ "tests/a.test.ts": "one\n" })
    const changedTree = git(changed, "rev-parse", "HEAD^{tree}")
    const deleted = repo({ "tests/a.test.ts": "one\n", "tests/b.test.ts": "b\n" })
    const deletedTree = git(deleted, "rev-parse", "HEAD^{tree}")
    git(deleted, "rm", "-q", "tests/b.test.ts")

    const afterChange = bindPrecheck(changed, changedTree, treeOf(changed, { "tests/a.test.ts": "uno\n" }), changedTree)
    const afterDelete = bindPrecheck(deleted, deletedTree, git(deleted, "write-tree"), deletedTree)

    assert.deepEqual(afterChange.test_change, { lines_removed: true, lines_added: true })
    assert.deepEqual(afterDelete.test_change, { lines_removed: true, lines_added: false })
  })

  it("bindPrecheck_countsABinaryTestFixtureChangeAsRemoved_becauseNoLineCountShowsItOnlyGrew", () => {
    const root = repo({ "tests/fixtures/a.bin": "\u0000one" })
    const precheckTree = git(root, "rev-parse", "HEAD^{tree}")

    const binding = bindPrecheck(root, precheckTree, treeOf(root, { "tests/fixtures/a.bin": "\u0000one-two" }), precheckTree)

    assert.equal(binding.test_change?.lines_removed, true)
  })

  it("bindPrecheck_keepsTheTestChangeEmpty_whenAnExistingTestFileOnlyChangesMode", () => {
    const root = repo({ "tests/a.test.ts": "one\n" })
    const precheckTree = git(root, "rev-parse", "HEAD^{tree}")
    chmodSync(join(root, "tests", "a.test.ts"), 0o755)
    git(root, "add", "-A")

    const binding = bindPrecheck(root, precheckTree, git(root, "write-tree"), precheckTree)

    assert.deepEqual(binding.test_change, { lines_removed: false, lines_added: false })
  })

  it("bindPrecheck_countsANewBinaryTestFixtureAsAdded_notAsRemoved", () => {
    const root = repo({ "tests/a.test.ts": "one\n" })
    const precheckTree = git(root, "rev-parse", "HEAD^{tree}")

    const binding = bindPrecheck(root, precheckTree, treeOf(root, { "tests/fixtures/new.bin": "\u0000new" }), precheckTree)

    assert.deepEqual(binding.test_change, { lines_removed: false, lines_added: true })
  })

  it("bindPrecheck_ignoresNonTestChangesInTheTestChange_andReportsNullForAnUnknownPrecheckTree", () => {
    const root = repo({ "lib/a.ts": "a\n" })
    const precheckTree = git(root, "rev-parse", "HEAD^{tree}")
    const end = treeOf(root, { "lib/a.ts": "b\n" })

    assert.deepEqual(bindPrecheck(root, precheckTree, end, precheckTree).test_change, { lines_removed: false, lines_added: false })
    assert.equal(bindPrecheck(root, precheckTree, end, TREE).test_change, null)
  })

  it("keelPrecheckBind_printsTheBindingAsJson_andRejectsAMissingOption", () => {
    const root = repo({ "lib/a.ts": "a\n" })
    const base = git(root, "rev-parse", "HEAD^{tree}")
    const end = treeOf(root, { "lib/a.ts": "b\n" })

    const printed = JSON.parse(execFileSync(KEEL, ["precheck", "bind", "--repo", root, "--base", base, "--end", end, "--tree", base], { encoding: "utf8" }))

    assert.deepEqual(printed, { blobs: { "lib/a.ts": git(root, "rev-parse", `${end}:lib/a.ts`) }, test_change: { lines_removed: false, lines_added: false } })
    assert.throws(() => execFileSync(KEEL, ["precheck", "bind", "--repo", root, "--base", base, "--end", end], { stdio: "pipe" }), (error: { status: number }) => error.status === 2)
  })
})

describe("precheckRequirement", () => {
  const roots: string[] = []
  after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
  const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  const changedRepo = (before: Record<string, string>, after: Record<string, string>): { root: string, base: string, end: string } => {
    const root = committedRepo(before)
    roots.push(root)
    const base = git(root, "rev-parse", "HEAD^{tree}")
    writeFiles(root, after)
    git(root, "add", "-A")
    return { root, base, end: git(root, "write-tree") }
  }

  it("precheckRequirement_isRequired_whenThreeScriptSourcesChangeInARepoWithPrecheckTests", () => {
    const { root, base, end } = changedRepo({ "tests/a.test.ts": "t\n" }, { "lib/a.ts": "a\n", "lib/b.mjs": "b\n", "hooks/c.tsx": "c\n" })

    assert.deepEqual(precheckRequirement(root, base, end), { required: true, sources: 3 })
  })

  it("precheckRequirement_isNotRequired_whenOnlyTwoScriptSourcesChange", () => {
    const { root, base, end } = changedRepo({ "tests/a.test.ts": "t\n" }, { "lib/a.ts": "a\n", "lib/b.ts": "b\n", "docs/c.md": "c\n", "tests/d.test.ts": "d\n" })

    assert.deepEqual(precheckRequirement(root, base, end), { required: false, sources: 2 })
  })

  it("precheckRequirement_doesNotCountADeletedSource", () => {
    const { root, base, end } = changedRepo({ "tests/a.test.ts": "t\n", "lib/gone.ts": "g\n" }, { "lib/a.ts": "a\n", "lib/b.ts": "b\n" })
    git(root, "rm", "-q", "lib/gone.ts")

    assert.deepEqual(precheckRequirement(root, base, git(root, "write-tree")), { required: false, sources: 2 })
  })

  it("precheckRequirement_isNotRequired_whenTheRepoHasNoTestTheRunnerCanRun", () => {
    const { root, base, end } = changedRepo({ "src/a.test.tsx": "t\n" }, { "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.tsx": "c\n" })

    assert.deepEqual(precheckRequirement(root, base, end), { required: false, sources: 3 })
  })

  it("keelPrecheckRequired_printsTheRequirementAsJson_andRejectsAMissingOption", () => {
    const { root, base, end } = changedRepo({ "tests/a.test.ts": "t\n" }, { "lib/a.ts": "a\n", "lib/b.ts": "b\n", "lib/c.ts": "c\n" })

    const printed = JSON.parse(execFileSync(KEEL, ["precheck", "required", "--repo", root, "--base", base, "--end", end], { encoding: "utf8" }))

    assert.deepEqual(printed, { required: true, sources: 3 })
    assert.throws(() => execFileSync(KEEL, ["precheck", "required", "--repo", root, "--base", base], { stdio: "pipe" }), (error: { status: number }) => error.status === 2)
  })
})

describe("precheckTreeOf", () => {
  it("precheckTreeOf_readsTheTreeFromTheFirstLineOnly", () => {
    assert.equal(precheckTreeOf(`precheck tree ${TREE} · base origin/develop · 7 paths`), TREE)
    assert.equal(precheckTreeOf(`precheck tree ${TREE}\nblobs     none`), TREE)
    assert.equal(precheckTreeOf(`note\nprecheck tree ${TREE}`), null)
    assert.equal(precheckTreeOf(`precheck tree ${TREE.slice(1)}`), null)
    assert.equal(precheckTreeOf(`precheck tree ${TREE}0`), null)
  })
})
