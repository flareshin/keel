import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"

import { entryExists } from "../../measure/lib/measurekit/files.ts"
import { LinkSandbox, assertExit, ops, onlyBackup, readFile } from "./helpers.ts"

describe("link unlink", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  const commitV1Tag = () => {
    box.git(box.data, "init", "-q")
    box.git(box.data, "add", "-A")
    box.git(box.data, "commit", "-q", "-m", "v1")
    box.git(box.data, "tag", "v1-final")
  }

  it("unlink_removesKeelLinksAndGeneratedClaudeMd_whenLinked", () => {
    assertExit(box.runLink("--write"), 0)
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(ops(result).filter((op) => op === "remove-link").length, 4)
    for (const target of ["skills/demo", "bin/keel", "commands/hello.md", "CLAUDE.md"]) assert.equal(entryExists(box.dataPath(target)), false, target)
    assert.equal(fs.existsSync(box.dataPath("state/keel/link-state.json")), false)
  })

  it("unlink_removesKeelOwnedSettingsKeysAndKeepsOthers_whenNoSettingsFileExistedBeforeKeel", () => {
    assertExit(box.runLink("--write"), 0)
    box.writeData("settings.json", box.readData("settings.json").replace("{", '{\n  "model": "opus",'))
    box.writeOverlay("settings/90-more.json", JSON.stringify({ permissions: { allow: ["Glob"] } }))
    assertExit(box.runLink("--write"), 0)
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.deepEqual(JSON.parse(box.readData("settings.json")), { model: "opus" })
    assert.ok(ops(result).includes("remove-owned-settings"))
  })

  it("unlink_keepsForeignLinkRealFileAndHandWrittenClaudeMd", () => {
    fs.mkdirSync(box.dataPath("bin"))
    fs.symlinkSync("/usr/bin/true", box.dataPath("bin/keel"))
    box.writeData("skills/demo/SKILL.md", "v1 skill\n")
    box.writeData("CLAUDE.md", "# v1 rules\n")
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.deepEqual(result.json.actions, [])
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), "/usr/bin/true")
    assert.equal(box.readData("skills/demo/SKILL.md"), "v1 skill\n")
    assert.equal(box.readData("CLAUDE.md"), "# v1 rules\n")
  })

  it("unlink_restoresTheMovedAsideClaudeMdByteForByte_afterAForcedWriteAndALaterWrite", () => {
    const v1 = "# v1 rules\r\n- keep\r\n- this"
    box.writeData("CLAUDE.md", v1)
    assertExit(box.runLink("--write", "--force"), 0)
    box.writeOverlay("PERSONAL.md", "# changed personal\n")
    assertExit(box.runLink("--write"), 0)
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(box.readData("CLAUDE.md"), v1)
    const restores = result.json.actions.filter((action: { op: string }) => action.op === "restore-claude-md")
    assert.equal(restores.length, 1)
    assert.equal(restores[0].path, box.dataPath("CLAUDE.md"))
  })

  it("unlink_restoresTheFirstMovedAsideClaudeMd_whenALaterForcedWriteMovedAnotherAside", () => {
    box.writeData("CLAUDE.md", "# v1 rules\n")
    assertExit(box.runLink("--write", "--force"), 0)
    box.writeData("CLAUDE.md", "# written after the swap\n")
    assertExit(box.runLink("--write", "--force"), 0)
    assertExit(box.runLink("--unlink"), 0)
    assert.equal(box.readData("CLAUDE.md"), "# v1 rules\n")
  })

  it("unlink_leavesABrokenSettingsFile_whenKeelCreatedIt", () => {
    assertExit(box.runLink("--write"), 0)
    box.writeData("settings.json", "{ broken")
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(box.readData("settings.json"), "{ broken")
    assert.ok(!ops(result).includes("remove-owned-settings"))
  })

  it("unlink_leavesClaudeMdMissing_whenTheMovedAsideCopyIsGone", () => {
    box.writeData("CLAUDE.md", "# v1 rules\n")
    assertExit(box.runLink("--write", "--force"), 0)
    fs.unlinkSync(onlyBackup(box, "CLAUDE.md"))
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(entryExists(box.dataPath("CLAUDE.md")), false)
    assert.ok(!ops(result).includes("restore-claude-md"))
  })

  it("unlink_keepsAHandWrittenClaudeMdAndTheMovedAsideCopy_whenTheUserReplacedTheGeneratedFile", () => {
    box.writeData("CLAUDE.md", "# v1 rules\n")
    assertExit(box.runLink("--write", "--force"), 0)
    box.writeData("CLAUDE.md", "# written after the swap\n")
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(box.readData("CLAUDE.md"), "# written after the swap\n")
    assert.equal(readFile(onlyBackup(box, "CLAUDE.md")), "# v1 rules\n")
    assert.ok(!ops(result).includes("restore-claude-md"))
  })

  it("unlink_printsNoV1RestoreHint_whenDataDirIsARepoWithAV1Tag", () => {
    box.writeData("CLAUDE.md", "# v1\n")
    box.writeData("settings.json", "{}\n")
    box.writeData("skills/demo/SKILL.md", "v1\n")
    commitV1Tag()
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(result.stderr, "")
  })

  it("unlink_printsNoV1RestoreHint_whenDataDirIsNotARepo", () => {
    const result = box.runLink("--unlink")
    assertExit(result, 0)
    assert.equal(result.stderr, "")
  })
})
