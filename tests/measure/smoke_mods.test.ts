import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { readText } from "./helpers.ts"
import { SmokeHarness } from "./smoke_helpers.ts"

const MOD_HOOKS = JSON.stringify({ modules: ["./register.js"] })
const HOOKS_ONLY = JSON.stringify({ hooks: { PreToolUse: [] } })
const OVERLAY_ORIGIN = "https://example.invalid/example/keel-overlay.git"

describe("mod-trust", () => {
  let harness: SmokeHarness

  beforeEach(() => {
    harness = new SmokeHarness()
  })
  afterEach(() => harness.cleanup())

  const assertStatus = (status: string, detail: string = "") => harness.assertStatus("mod-trust", "all", status, detail)

  function pluginDir(relativePath: string, hooksJson: string): string {
    harness.box.write(path.join(relativePath, "hooks", "hooks.json"), hooksJson)
    return path.join(harness.box.root, relativePath)
  }

  function install(...plugins: [string, string][]): void {
    harness.box.installPlugins(plugins.map(([id, installPath]) => ({ id, installPath })))
  }

  function commitOverlayMod(): string {
    const mod = pluginDir("overlay/mods/own", MOD_HOOKS)
    harness.box.write("overlay/mods/own/hooks/register.js", "module.exports = {};\n")
    harness.box.initRepo(harness.box.overlay, OVERLAY_ORIGIN)
    harness.box.commitAll(harness.box.overlay)
    return mod
  }

  function linkedOverlayWorktree(): string {
    const worktree = path.join(harness.box.root, "overlay-wt")
    harness.box.git(harness.box.overlay, "worktree", "add", "-q", "--detach", worktree)
    return worktree
  }

  it("modTrust_failsListingTheId_whenAnInstalledModIsUnreviewed", () => {
    install(["a-mod@market", pluginDir("plugins/a-mod", MOD_HOOKS)])
    const item = assertStatus("FAIL", "unreviewed mods: a-mod@market")
    assert.ok(item.detail.includes("claude plugin validate"))
    assert.ok(item.detail.includes("reviewed-mods.txt"))
  })

  it("modTrust_passesAfterAskingTheCliForJson_whenTheModIdIsInTheReviewedList", () => {
    install(["a-mod@market", pluginDir("plugins/a-mod", MOD_HOOKS)])
    harness.box.write("overlay/reviewed-mods.txt", "# read with claude plugin validate\na-mod@market\n")
    assertStatus("PASS", "no unreviewed mod among 1 plugins")
    assert.equal(readText(path.join(harness.box.root, "stubs", "claude.calls")), "plugin list --json\n")
  })

  it("modTrust_ignoresPlugins_whoseHooksJsonListsNoModulesOrIsAbsent", () => {
    install(
      ["hooks-only@market", pluginDir("plugins/hooks-only", HOOKS_ONLY)],
      ["empty-modules@market", pluginDir("plugins/empty-modules", JSON.stringify({ modules: [] }))],
      ["no-hooks@market", path.join(harness.box.root, "plugins", "no-hooks")],
    )
    assertStatus("PASS", "no unreviewed mod among 3 plugins")
  })

  it("modTrust_countsAPluginAsAMod_whenItsHooksJsonDoesNotParse", () => {
    install(["broken@market", pluginDir("plugins/broken", '{"modules": ["./r.js"],}')])
    assertStatus("FAIL", "unreviewed mods: broken@market")
  })

  it("modTrust_passes_forACommittedCleanOverlayModReachedThroughALink", () => {
    const mod = commitOverlayMod()
    fs.mkdirSync(path.join(harness.box.data, "mods"), { recursive: true })
    fs.symlinkSync(mod, path.join(harness.box.data, "mods", "own"))
    install(["own@inline", path.join(harness.box.data, "mods", "own")])
    assertStatus("PASS", "no unreviewed mod among 1 plugins")
  })

  it("modTrust_passes_forAModCommittedInTheMainOverlay_whenTheOverlayDirIsALinkedWorktree", () => {
    const mod = commitOverlayMod()
    harness.box.env["KEEL_OVERLAY_DIR"] = linkedOverlayWorktree()
    install(["own@inline", mod])
    assertStatus("PASS", "no unreviewed mod among 1 plugins")
  })

  it("modTrust_fails_whenTheMainOverlayModHasAnUncommittedChange_andTheOverlayDirIsALinkedWorktree", () => {
    const mod = commitOverlayMod()
    harness.box.env["KEEL_OVERLAY_DIR"] = linkedOverlayWorktree()
    harness.box.write("overlay/mods/own/hooks/register.js", "module.exports = {changed: true};\n")
    install(["own@inline", mod])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_fails_forAModInstalledFromTheLinkedOverlayWorktree", () => {
    commitOverlayMod()
    const worktree = linkedOverlayWorktree()
    harness.box.env["KEEL_OVERLAY_DIR"] = worktree
    install(["own@inline", path.join(worktree, "mods", "own")])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_fails_forAModInsideTheOverlay_whenTheOverlayIsNotAGitRepo", () => {
    harness.box.write("overlay/mods/own/hooks/register.js", "module.exports = {};\n")
    install(["own@inline", pluginDir("overlay/mods/own", MOD_HOOKS)])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_fails_whenTheOverlayModHasAnUncommittedChange", () => {
    const mod = commitOverlayMod()
    harness.box.write("overlay/mods/own/hooks/hooks.json", JSON.stringify({ modules: ["./register.js", "./extra.js"] }))
    install(["own@inline", mod])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_fails_whenTheOverlayModGainsAnUntrackedFile", () => {
    const mod = commitOverlayMod()
    harness.box.write("overlay/mods/own/extra.js", "module.exports = {};\n")
    install(["own@inline", mod])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_fails_whenTheOverlayModIsIgnoredAndSoNeverCommitted", () => {
    harness.box.initRepo(harness.box.overlay, OVERLAY_ORIGIN)
    harness.box.write("overlay/.gitignore", "mods/\n")
    harness.box.commitAll(harness.box.overlay)
    install(["own@inline", pluginDir("overlay/mods/own", MOD_HOOKS)])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_fails_whenTheCommittedOverlayModListsAnIgnoredModule", () => {
    harness.box.initRepo(harness.box.overlay, OVERLAY_ORIGIN)
    const mod = pluginDir("overlay/mods/own", JSON.stringify({ modules: ["./dist/register.js"] }))
    harness.box.write("overlay/mods/own/.gitignore", "dist/\n")
    harness.box.commitAll(harness.box.overlay)
    harness.box.write("overlay/mods/own/hooks/dist/register.js", "module.exports = {};\n")
    install(["own@inline", mod])
    assertStatus("FAIL", "unreviewed mods: own@inline")
  })

  it("modTrust_countsAPluginAsAMod_whenItsModulesIsAnObject", () => {
    install(["odd@market", pluginDir("plugins/odd", JSON.stringify({ modules: {} }))])
    assertStatus("FAIL", "unreviewed mods: odd@market")
  })

  it("modTrust_countsAPluginAsAMod_whenItsModulesIsNull", () => {
    install(["odd@market", pluginDir("plugins/odd", JSON.stringify({ modules: null }))])
    assertStatus("FAIL", "unreviewed mods: odd@market")
  })

  it("modTrust_countsAPluginAsAMod_whenItsHooksJsonIsNotAnObject", () => {
    install(["odd@market", pluginDir("plugins/odd", "[]")])
    assertStatus("FAIL", "unreviewed mods: odd@market")
  })

  it("modTrust_doesNotExempt_aCommittedModReachedByTraversingOutOfTheOverlay", () => {
    const repo = path.join(harness.box.root, "outer")
    harness.box.write("outer/overlay/README.md", "Overlay.\n")
    pluginDir("outer/beside", MOD_HOOKS)
    harness.box.write("outer/beside/hooks/register.js", "module.exports = {};\n")
    harness.box.initRepo(repo, "https://example.invalid/example/outer.git")
    harness.box.commitAll(repo)
    harness.box.env["KEEL_OVERLAY_DIR"] = path.join(repo, "overlay")
    install(["beside@inline", path.join(repo, "overlay", "..", "beside")])
    assertStatus("FAIL", "unreviewed mods: beside@inline")
  })

  it("modTrust_doesNotExempt_aCommittedModBesideTheOverlay_whenTheOverlayDirIsASubdirectoryOfALinkedWorktree", () => {
    const repo = path.join(harness.box.root, "outer")
    harness.box.write("outer/overlay/README.md", "Overlay.\n")
    pluginDir("outer/beside", MOD_HOOKS)
    harness.box.write("outer/beside/hooks/register.js", "module.exports = {};\n")
    harness.box.initRepo(repo, "https://example.invalid/example/outer.git")
    harness.box.commitAll(repo)
    const worktree = path.join(harness.box.root, "outer-wt")
    harness.box.git(repo, "worktree", "add", "-q", "--detach", worktree)
    harness.box.env["KEEL_OVERLAY_DIR"] = path.join(worktree, "overlay")
    install(["beside@inline", path.join(repo, "beside")])
    assertStatus("FAIL", "unreviewed mods: beside@inline")
  })

  it("modTrust_warns_whenTheClaudeCliIsMissing", () => {
    fs.rmSync(harness.box.claudeStub)
    assertStatus("WARN", "mod check could not run: ")
  })

  it("modTrust_warns_whenTheCliExitsNonZero_evenWithAParsableList", () => {
    harness.box.write("stubs/claude", "#!/bin/bash\necho '[]'\necho 'unknown command' >&2\nexit 1\n", true)
    assertStatus("WARN", "mod check could not run: ")
  })

  it("modTrust_warns_whenThePluginListIsNotJson", () => {
    harness.box.write("stubs/plugins.json", "Installed plugins:\n  a-mod@market\n")
    assertStatus("WARN", "mod check could not run: ")
  })

  it("modTrust_warns_whenAPluginEntryHasNoInstallPath", () => {
    harness.box.write("stubs/plugins.json", JSON.stringify([{ id: "a-mod@market", path: "/somewhere" }]))
    assertStatus("WARN", "mod check could not run: ")
  })
})
