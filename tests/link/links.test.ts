import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { entryExists, isSymlink } from "../../measure/lib/measurekit/files.ts"
import { LinkSandbox, assertExit, ops, onlyBackup, problemKinds, readFile } from "./helpers.ts"

describe("link write links", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  it("write_createsEveryManifestLink_whenTargetsAreMissing", () => {
    const result = box.runLink("--write")
    assertExit(result, 0)
    assert.equal(fs.readlinkSync(box.dataPath("skills/demo")), path.join(box.keel, "skills/demo"))
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), path.join(box.keel, "bin/keel"))
    assert.equal(fs.readlinkSync(box.dataPath("commands/hello.md")), path.join(box.overlay, "commands/hello.md"))
    assert.equal(ops(result).filter((op) => op === "symlink").length, 3)
  })

  it("write_changesNothing_whenRunTwice", () => {
    assertExit(box.runLink("--write"), 0)
    const second = box.runLink("--write")
    assertExit(second, 0)
    assert.deepEqual(second.json.actions, [])
  })

  it("write_replacesLink_whenKeelLinkPointsAtAnOldKeelPath", () => {
    fs.mkdirSync(box.dataPath("skills"))
    fs.symlinkSync(path.join(box.keel, "skills/old"), box.dataPath("skills/demo"))
    const result = box.runLink("--write")
    assertExit(result, 0)
    assert.deepEqual(result.json.actions.find((action: { op: string }) => action.op === "replace-link"), { op: "replace-link", path: box.dataPath("skills/demo") })
    assert.equal(fs.readlinkSync(box.dataPath("skills/demo")), path.join(box.keel, "skills/demo"))
  })

  it("write_refusesAndWritesNothing_whenTargetIsARegularFile", () => {
    box.writeData("bin/keel", "v1 content\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["target-occupied"])
    assert.equal(box.readData("bin/keel"), "v1 content\n")
    assert.equal(entryExists(box.dataPath("skills/demo")), false)
    assert.equal(fs.existsSync(box.dataPath("CLAUDE.md")), false)
  })

  it("write_refuses_whenTargetIsARealDirectoryWithoutForce", () => {
    box.writeData("skills/demo/SKILL.md", "v1 skill\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["target-occupied"])
    assert.equal(box.readData("skills/demo/SKILL.md"), "v1 skill\n")
  })

  it("write_movesRealDirectoryAsideAndLinks_whenForced", () => {
    box.writeData("skills/demo/SKILL.md", "v1 skill\n")
    const result = box.runLink("--write", "--force")
    assertExit(result, 0)
    assert.ok(result.json.actions.some((action: { op: string; path: string }) => action.op === "symlink" && action.path === box.dataPath("skills/demo")))
    assert.equal(fs.readlinkSync(box.dataPath("skills/demo")), path.join(box.keel, "skills/demo"))
    assert.equal(readFile(onlyBackup(box, "skills/demo/SKILL.md")), "v1 skill\n")
    assert.ok(result.stderr.includes("moves it to"))
  })

  it("write_movesRegularFileAsideAndLinks_whenForced", () => {
    box.writeData("bin/keel", "v1 content\n")
    const result = box.runLink("--write", "--force")
    assertExit(result, 0)
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), path.join(box.keel, "bin/keel"))
    assert.equal(readFile(onlyBackup(box, "bin/keel")), "v1 content\n")
  })

  it("write_refuses_whenTargetIsAForeignLinkWithoutForce", () => {
    fs.mkdirSync(box.dataPath("bin"))
    fs.symlinkSync("/usr/bin/true", box.dataPath("bin/keel"))
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["link-wrong"])
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), "/usr/bin/true")
  })

  it("write_replacesForeignLink_whenForced", () => {
    fs.mkdirSync(box.dataPath("bin"))
    fs.symlinkSync("/usr/bin/true", box.dataPath("bin/keel"))
    const result = box.runLink("--write", "--force")
    assertExit(result, 0)
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), path.join(box.keel, "bin/keel"))
    assert.equal(fs.readlinkSync(onlyBackup(box, "bin/keel")), "/usr/bin/true")
  })

  it("write_refuses_whenLinkSourceDoesNotExist", () => {
    box.writeKeel("settings/links.tsv", "source\ttarget\n{{KEEL}}/skills/absent\tskills/absent\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.deepEqual(problemKinds(result), ["dangling"])
    assert.equal(entryExists(box.dataPath("skills/absent")), false)
  })

  for (const target of ["../escape", "/abs/path", "skills/../../x"]) {
    it(`write_refuses_whenTargetEscapesTheDataDir_${target}`, () => {
      box.writeKeel("settings/links.tsv", `source\ttarget\n{{KEEL}}/bin/keel\t${target}\n`)
      const result = box.runLink("--write")
      assertExit(result, 3)
      assert.ok(result.stderr.includes("target must be a relative path"))
    })
  }

  it("write_refuses_whenManifestUsesAnUnknownPlaceholder", () => {
    box.writeKeel("settings/links.tsv", "source\ttarget\n{{HOME}}/x\tx\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("unknown placeholder {{HOME}}"))
  })

  it("write_refuses_whenTwoManifestsDeclareTheSameTarget", () => {
    box.writeOverlay("links.tsv", "source\ttarget\n{{OVERLAY}}/commands/hello.md\tbin/keel\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("already declared"))
  })

  it("write_refuses_whenManifestHeaderIsWrong", () => {
    box.writeKeel("settings/links.tsv", "from\tto\n{{KEEL}}/bin/keel\tbin/keel\n")
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("header must be exactly"))
  })

  it("write_linksOnlyKeelEntries_whenOverlayDirIsMissing", () => {
    fs.rmSync(box.overlay, { recursive: true })
    const result = box.runLink("--write")
    assertExit(result, 0)
    assert.equal(isSymlink(box.dataPath("bin/keel")), true)
    assert.equal(entryExists(box.dataPath("commands/hello.md")), false)
  })
})

describe("link worktree guard", () => {
  let box: LinkSandbox
  let worktree: string

  beforeEach(() => {
    box = new LinkSandbox()
    box.git(box.keel, "init", "-q")
    box.git(box.keel, "add", "-A")
    box.git(box.keel, "commit", "-q", "-m", "init")
    worktree = path.join(box.root, "keel-wt")
    box.git(box.keel, "worktree", "add", "-q", worktree)
  })
  afterEach(() => box.remove())

  const runFromWorktree = (...args: string[]) => {
    box.keel = worktree
    return box.runLink(...args)
  }
  const writeUnadoptedSettings = () => box.writeData("settings.json", JSON.stringify({ permissions: { allow: ["Read"] } }) + "\n")

  it("write_refuses_whenKeelHomeIsALinkedWorktree", () => {
    const result = runFromWorktree("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("linked worktree"))
    assert.equal(entryExists(box.dataPath("bin/keel")), false)
  })

  it("write_proceeds_whenWorktreeIsExplicitlyAllowed", () => {
    const result = runFromWorktree("--write", "--allow-worktree")
    assertExit(result, 0)
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), path.join(worktree, "bin/keel"))
  })

  it("write_hintsAllowWorktree_whenRefusedFromAnAllowedLinkedWorktree", () => {
    writeUnadoptedSettings()
    const result = runFromWorktree("--write", "--allow-worktree")
    assertExit(result, 3)
    assert.ok(problemKinds(result).includes("settings-unadopted"))
    assert.ok(result.stderr.includes("run: bin/link --write --adopt --accept-drops <file> --allow-worktree"))
  })

  it("adopt_hintsAllowWorktreeInTheAcceptDropsRefusal_whenRunFromAnAllowedLinkedWorktree", () => {
    writeUnadoptedSettings()
    const result = runFromWorktree("--write", "--adopt", "--allow-worktree")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("run: bin/link --write --adopt --accept-drops <file> --allow-worktree"))
  })

  it("write_hintsNoAllowWorktree_whenRefusedFromTheMainCheckout", () => {
    writeUnadoptedSettings()
    const result = box.runLink("--write")
    assertExit(result, 3)
    assert.ok(result.stderr.includes("run: bin/link --write --adopt --accept-drops <file>"))
    assert.ok(!result.stderr.includes("--allow-worktree"))
  })

  it("write_proceeds_whenKeelHomeIsTheMainCheckout", () => {
    assertExit(box.runLink("--write"), 0)
  })
})

describe("link dry run and usage", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
  })
  afterEach(() => box.remove())

  it("dryRun_listsPlannedActionsAndWritesNothing_whenNoFlagIsGiven", () => {
    const result = box.runLink()
    assertExit(result, 0)
    assert.deepEqual(ops(result), ["merge-settings", "set-hooks-path", "symlink", "symlink", "symlink", "write-claude-md"])
    assert.deepEqual(fs.readdirSync(box.data), [])
  })

  it("cli_exitsWithUsageError_whenForceIsGivenWithoutWrite", () => {
    assertExit(box.runLink("--check", "--force"), 2)
  })

  it("cli_exitsWithUsageError_whenTwoModesAreGiven", () => {
    assertExit(box.runLink("--check", "--write"), 2)
  })
})
