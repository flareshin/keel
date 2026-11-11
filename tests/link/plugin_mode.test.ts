import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"

import { entryExists } from "../../measure/lib/measurekit/files.ts"
import { LinkSandbox, assertExit, problemKinds, readFile } from "./helpers.ts"

const LEDGER_HEADER =
  "id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\t" +
  "incidents\tmetric\treview_by\tgrace_until\tstatus"
const DEMO_ROW = ["F-demo", "core", "floor", "A demo rule.", "hook", "hook:demo", "-", "-", "-", "fires:F-demo", "-", "-", "active"].join("\t")
const PLUGIN_HOOKS = {
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/demo.py" }] }] },
}
const KEEL_PLUGIN_ID = "keel@keel"

function liveSettings(box: LinkSandbox): Record<string, any> {
  return JSON.parse(box.readData("settings.json"))
}

function enablePlugin(box: LinkSandbox, enabled: boolean = true): void {
  const settings = liveSettings(box)
  settings["enabledPlugins"] = { [KEEL_PLUGIN_ID]: enabled }
  box.writeData("settings.json", JSON.stringify(settings, null, 2) + "\n")
}

function hookCommands(box: LinkSandbox): string[] {
  const hooks = liveSettings(box)["hooks"] ?? {}
  return Object.values(hooks).flat().flatMap((group: any) => group.hooks.map((hook: any) => hook.command))
}

describe("link plugin mode", () => {
  let box: LinkSandbox

  beforeEach(() => {
    box = new LinkSandbox()
    box.writeKeel("ledger.tsv", LEDGER_HEADER + "\n" + DEMO_ROW + "\n")
    box.writeKeel("hooks/hooks.json", JSON.stringify(PLUGIN_HOOKS))
    assertExit(box.runLink("--write"), 0)
  })
  afterEach(() => box.remove())

  it("pluginWrite_removesWhatThePluginProvides_andKeepsTheCliLinkOverlayLinksAndCorePermissions", () => {
    enablePlugin(box)
    assertExit(box.runLink("--write", "--plugin"), 0)
    assert.equal(entryExists(box.dataPath("skills/demo")), false)
    assert.equal(entryExists(box.dataPath("CLAUDE.md")), false)
    assert.equal(fs.readlinkSync(box.dataPath("bin/keel")), `${box.keel}/bin/keel`)
    assert.ok(entryExists(box.dataPath("commands/hello.md")))
    assert.deepEqual(hookCommands(box), [])
    assert.ok(liveSettings(box)["permissions"]["deny"].includes("Bash(git push --force:*)"))
    assert.deepEqual(liveSettings(box)["enabledPlugins"], { [KEEL_PLUGIN_ID]: true })
  })

  it("pluginWrite_refusesAndWritesNothing_whenTheKeelPluginIsNotEnabled", () => {
    for (const enabled of [null, false]) {
      if (enabled !== null) enablePlugin(box, enabled)
      const before = box.readData("settings.json")
      const result = box.runLink("--write", "--plugin")
      assertExit(result, 3)
      assert.ok(problemKinds(result).includes("plugin-not-enabled"), result.stdout)
      assert.ok(entryExists(box.dataPath("skills/demo")))
      assert.ok(entryExists(box.dataPath("CLAUDE.md")))
      assert.equal(box.readData("settings.json"), before)
    }
  })

  it("pluginWrite_isRecorded_soCheckIsCleanAndAPlainWriteChangesNothing", () => {
    enablePlugin(box)
    assertExit(box.runLink("--write", "--plugin"), 0)
    assertExit(box.runLink("--check"), 0)
    const again = box.runLink("--write")
    assertExit(again, 0)
    assert.deepEqual(again.json.actions, [])
    assert.equal(entryExists(box.dataPath("skills/demo")), false)
    assert.deepEqual(box.runLink("--write", "--plugin").json.actions, [])
  })

  it("check_reportsPluginNotEnabled_whenThePluginIsDisabledAfterPluginMode", () => {
    enablePlugin(box)
    assertExit(box.runLink("--write", "--plugin"), 0)
    enablePlugin(box, false)
    const result = box.runLink("--check")
    assertExit(result, 1)
    assert.ok(problemKinds(result).includes("plugin-not-enabled"))
  })

  it("fullWrite_restoresTheLinksClaudeMdAndCoreHooks_afterPluginMode", () => {
    enablePlugin(box)
    assertExit(box.runLink("--write", "--plugin"), 0)
    assertExit(box.runLink("--write", "--full"), 0)
    assert.equal(fs.readlinkSync(box.dataPath("skills/demo")), `${box.keel}/skills/demo`)
    assert.ok(readFile(box.dataPath("CLAUDE.md")).includes("[K1]"))
    assert.deepEqual(hookCommands(box), [`python3 ${box.keel}/hooks/demo.py`])
    assertExit(box.runLink("--check"), 0)
  })

  it("pluginWrite_leavesAForeignLinkAndARealDirectory_whereThePluginProvidesTheComponent", () => {
    enablePlugin(box)
    box.writeKeel("settings/links.tsv", "source\ttarget\n{{KEEL}}/skills/demo\tskills/demo\n{{KEEL}}/skills/other\tskills/other\n{{KEEL}}/bin/keel\tbin/keel\n")
    box.writeKeel("skills/other/SKILL.md", "# other\n")
    fs.unlinkSync(box.dataPath("skills/demo"))
    fs.symlinkSync("/usr/bin/true", box.dataPath("skills/demo"))
    box.writeData("skills/other/SKILL.md", "mine\n")
    assertExit(box.runLink("--write", "--plugin"), 0)
    assert.equal(fs.readlinkSync(box.dataPath("skills/demo")), "/usr/bin/true")
    assert.equal(box.readData("skills/other/SKILL.md"), "mine\n")
  })

  it("pluginCheck_reportsHookUnregistered_whenALedgerHookIsInNeitherSettingsNorThePluginHooks", () => {
    enablePlugin(box)
    assertExit(box.runLink("--write", "--plugin"), 0)
    box.writeKeel("hooks/hooks.json", JSON.stringify({ hooks: {} }))
    assert.ok(problemKinds(box.runLink("--check")).includes("hook-unregistered"))
  })

  it("check_readsAnExplicitFullMode_asTheLinkInstall", () => {
    const statePath = box.dataPath("state/keel/link-state.json")
    fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFile(statePath)), mode: "full" }))
    assertExit(box.runLink("--check"), 0)
    assert.deepEqual(box.runLink("--write").json.actions, [])
  })

  it("check_failsNamingTheMode_whenTheRecordedModeIsUnknown", () => {
    const statePath = box.dataPath("state/keel/link-state.json")
    fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFile(statePath)), mode: "partial" }))
    const result = box.runLink("--check")
    assertExit(result, 70)
    assert.ok(result.stderr.includes('mode must be "full" or "plugin", got "partial"'), result.stderr)
  })

  it("modeFlags_areUsageErrors_withCheckUnlinkOrEachOther", () => {
    for (const args of [["--check", "--plugin"], ["--unlink", "--full"], ["--write", "--plugin", "--full"]]) {
      assertExit(box.runLink(...args), 2)
    }
  })
})
