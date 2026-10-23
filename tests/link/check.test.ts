import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { LinkSandbox, assertExit, problemKinds } from "./helpers.ts"
import type { LinkResult } from "./helpers.ts"

function snapshotData(root: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else snapshot.set(entryPath, entry.isSymbolicLink() ? "link:" + fs.readlinkSync(entryPath) : "file:" + fs.readFileSync(entryPath).toString("latin1"))
    }
  }
  visit(root)
  return snapshot
}

describe("link check", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
    assertExit(box.runLink("--write"), 0)
  })
  afterEach(() => box.remove())

  const checkWithoutWriting = (): LinkResult => {
    const before = snapshotData(box.data)
    const result = box.runLink("--check")
    assert.deepEqual(snapshotData(box.data), before, "--check must not write")
    return result
  }

  it("check_passesWithNoProblems_whenEverythingMatches", () => {
    const result = checkWithoutWriting()
    assertExit(result, 0)
    assert.deepEqual(result.json, { actions: [], problems: [] })
  })

  it("check_reportsLinkMissing_whenALinkWasDeleted", () => {
    fs.unlinkSync(box.dataPath("bin/keel"))
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.equal(result.json.problems[0].kind, "link-missing")
    assert.equal(result.json.problems[0].path, box.dataPath("bin/keel"))
  })

  it("check_reportsLinkWrong_whenALinkPointsElsewhere", () => {
    fs.unlinkSync(box.dataPath("bin/keel"))
    fs.symlinkSync("/usr/bin/true", box.dataPath("bin/keel"))
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["link-wrong"])
  })

  it("check_reportsTargetOccupied_whenALinkWasReplacedByARegularFile", () => {
    fs.unlinkSync(box.dataPath("bin/keel"))
    box.writeData("bin/keel", "copied file\n")
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["target-occupied"])
  })

  it("check_reportsDangling_whenTheLinkSourceWasRemoved", () => {
    fs.unlinkSync(path.join(box.keel, "bin", "keel"))
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["dangling"])
  })

  it("check_reportsClaudeMdDrift_whenPrinciplesChanged", () => {
    box.writeKeel("PRINCIPLES.md", "- [K1] Changed.\n")
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["claude-md-drift"])
  })

  it("check_reportsSettingsDriftWithoutValues_whenOwnedKeyWasEdited", () => {
    const live = JSON.parse(box.readData("settings.json"))
    live.env.ACME_NOTES_DIR = "secret-value"
    box.writeData("settings.json", JSON.stringify(live))
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["settings-drift"])
    assert.ok(result.json.problems[0].detail.includes("env.ACME_NOTES_DIR: differs"))
    assert.ok(!(result.stdout + result.stderr).includes("secret-value"))
  })

  it("check_reportsSettingsDriftWithoutValues_whenLiveHoldsAnOwnedKeyNoFragmentDeclares", () => {
    fs.unlinkSync(path.join(box.overlay, "settings", "50-permissions.json"))
    const result = checkWithoutWriting()
    assertExit(result, 1)
    assert.deepEqual(problemKinds(result), ["settings-drift"])
    assert.ok(result.json.problems[0].detail.includes("env: declared by no fragment"))
    assert.ok(!(result.stdout + result.stderr).includes(box.data + "/notes"))
  })

  it("check_ignoresUnownedKeys_whenTheyChange", () => {
    const live = JSON.parse(box.readData("settings.json"))
    live.model = "anything"
    box.writeData("settings.json", JSON.stringify(live))
    assertExit(checkWithoutWriting(), 0)
  })
})
