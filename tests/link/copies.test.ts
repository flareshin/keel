import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { entryExists, isSymlink } from "../../measure/lib/measurekit/files.ts"
import { LinkSandbox, assertExit, onlyBackup, problemKinds, readFile, writeFile } from "./helpers.ts"

const TASK = "scheduled-tasks/demo/SKILL.md"
const TASK_TEXT = "---\nname: demo\n---\nRun the demo.\n"
const OVERLAY_LINKS =
  "source\ttarget\n" +
  "{{OVERLAY}}/commands/hello.md\tcommands/hello.md\n" +
  "{{OVERLAY}}/scheduled-tasks/demo/SKILL.md\tscheduled-tasks/demo/SKILL.md\n"

describe("link copies scheduled tasks", () => {
  let box: LinkSandbox
  let source: string
  let target: string

  beforeEach(() => {
    box = new LinkSandbox()
    box.writeOverlay(TASK, TASK_TEXT)
    box.writeOverlay("links.tsv", OVERLAY_LINKS)
    source = path.join(box.overlay, TASK)
    target = box.dataPath(TASK)
  })
  afterEach(() => box.remove())

  const hasAction = (result: { json: any }, op: string) =>
    result.json.actions.some((action: { op: string; path: string }) => action.op === op && action.path === target)
  const writeElsewhere = () => {
    const elsewhere = path.join(box.root, "elsewhere.md")
    fs.writeFileSync(elsewhere, "not keel\n")
    return elsewhere
  }

  it("write_copiesScheduledTaskFile_whenTargetIsMissing", () => {
    const result = box.runLink("--write")
    assertExit(result, 0)
    assert.equal(isSymlink(target), false)
    assert.equal(box.readData(TASK), TASK_TEXT)
    assert.ok(hasAction(result, "copy"))
    assert.equal(isSymlink(box.dataPath("commands/hello.md")), true)
  })

  it("write_keepsSourcePermissionBits_whenCopying", () => {
    fs.chmodSync(source, 0o640)
    assertExit(box.runLink("--write"), 0)
    assert.equal(fs.statSync(target).mode & 0o7777, 0o640)
  })

  it("write_changesNothing_whenCopyMatchesSource", () => {
    assertExit(box.runLink("--write"), 0)
    const second = box.runLink("--write")
    assertExit(second, 0)
    assert.deepEqual(second.json.actions, [])
  })

  it("write_replacesKeelLinkWithCopy_whenTaskIsStillASymlink", () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(source, target)
    const result = box.runLink("--write")
    assertExit(result, 0)
    assert.ok(hasAction(result, "copy"))
    assert.equal(isSymlink(target), false)
    assert.equal(box.readData(TASK), TASK_TEXT)
  })

  it("write_refusesAndKeepsCopy_whenCopyDiffersFromSourceWithoutForce", () => {
    box.writeData(TASK, "edited in the app\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["copy-drift"])
    assert.equal(box.readData(TASK), "edited in the app\n")
  })

  it("write_refreshesCopyAndMovesOldAside_whenForced", () => {
    box.writeData(TASK, "edited in the app\n")
    const result = box.runLink("--write", "--force")
    assertExit(result, 0)
    assert.ok(hasAction(result, "copy"))
    assert.equal(isSymlink(target), false)
    assert.equal(box.readData(TASK), TASK_TEXT)
    assert.equal(readFile(onlyBackup(box, TASK)), "edited in the app\n")
  })

  it("write_refuses_whenForeignLinkSitsAtTaskWithoutForce", () => {
    const elsewhere = writeElsewhere()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(elsewhere, target)
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["link-wrong"])
    assert.equal(fs.readlinkSync(target), elsewhere)
  })

  it("write_refusesEvenWhenForced_whenSourceIsMissing", () => {
    fs.unlinkSync(source)
    const result = box.runLink("--write", "--force")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["dangling"])
    assert.equal(entryExists(target), false)
  })

  it("write_refuses_whenDirectorySitsAtTaskWithoutForce", () => {
    fs.mkdirSync(target, { recursive: true })
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["target-occupied"])
    assert.equal(fs.statSync(target).isDirectory(), true)
  })

  it("write_movesForeignLinkAsideAndCopies_whenForced", () => {
    const elsewhere = writeElsewhere()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(elsewhere, target)
    const result = box.runLink("--write", "--force")
    assertExit(result, 0)
    assert.equal(isSymlink(target), false)
    assert.equal(box.readData(TASK), TASK_TEXT)
    assert.equal(fs.readlinkSync(onlyBackup(box, TASK)), elsewhere)
  })

  it("write_movesDirectoryAsideAndCopies_whenForced", () => {
    writeFile(path.join(target, "stray.md"), "stray\n")
    const result = box.runLink("--write", "--force")
    assertExit(result, 0)
    assert.equal(box.readData(TASK), TASK_TEXT)
    assert.equal(readFile(path.join(onlyBackup(box, TASK), "stray.md")), "stray\n")
  })

  it("check_reportsCopyDrift_whenSourceChangedAfterCopy", () => {
    assertExit(box.runLink("--write"), 0)
    box.writeOverlay(TASK, TASK_TEXT + "New step.\n")
    const result = box.runLink("--check")
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["copy-drift"])
  })

  it("check_reportsCopyMissing_whenTargetIsAbsent", () => {
    assertExit(box.runLink("--write"), 0)
    fs.unlinkSync(target)
    const result = box.runLink("--check")
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["copy-missing"])
  })
})
