import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { mergeFragments } from "../../lib/link/fragments.ts"
import type { JsonObject } from "../../measure/lib/measurekit/json.ts"

const KEEL_ROOT = path.resolve(import.meta.dirname, "..", "..")
const LINK_PLACEHOLDER = "{{KEEL}}"
const PLUGIN_ROOT_VARIABLE = "${CLAUDE_PLUGIN_ROOT}"
const PRINCIPLES_EVENTS = ["SessionStart", "SubagentStart"]

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(KEEL_ROOT, relativePath), "utf8")) as Record<string, unknown>
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(KEEL_ROOT, relativePath), "utf8")
}

describe("plugin manifest", () => {
  it("pluginHooks_registerTheSameHooksAsTheLinkCoreFragment_besidesThePrinciplesEvents", () => {
    const linkHooks = JSON.parse(readText("settings/core.json").replaceAll(LINK_PLACEHOLDER, PLUGIN_ROOT_VARIABLE))
    const pluginHooks = readJson("hooks/hooks.json")["hooks"] as Record<string, unknown>
    const sharedEvents = Object.fromEntries(Object.entries(pluginHooks).filter(([event]) => !PRINCIPLES_EVENTS.includes(event)))
    assert.deepEqual(sharedEvents, linkHooks.hooks)
  })

  it("coreFragment_runsTheBashGuardsOnSkillShellCommands_failingClosed", () => {
    const core = readJson("settings/core.json") as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; onFailure?: string }> }>> }
    const bashGuards = (event: string) => (core.hooks[event] ?? [])
      .filter((group) => (group.matcher ?? "").split("|").includes("Bash"))
      .flatMap((group) => group.hooks)
      .filter((hook) => hook.onFailure === "block")
      .map((hook) => hook.command)
    assert.deepEqual(bashGuards("PreSkillShellCommand"), bashGuards("PreToolUse"))
  })

  it("coreFragment_turnsOnCodeMode_inTheMergedUserSettingsEnv", () => {
    const core = readJson("settings/core.json") as JsonObject
    const [merged, conflicts] = mergeFragments([["settings/core.json", core]])
    assert.deepEqual(merged["env"], { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" })
    assert.deepEqual(conflicts, [])
  })

  it("pluginHooks_injectThePrinciplesAtSessionAndSubagentStart", () => {
    const pluginHooks = readJson("hooks/hooks.json")["hooks"] as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    for (const event of PRINCIPLES_EVENTS) {
      const commands = (pluginHooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
      assert.deepEqual(commands.map((command) => command.endsWith(`${PLUGIN_ROOT_VARIABLE}/hooks/principles/principles.ts`)), [true], event)
    }
  })

  it("pluginHooks_injectThePrinciplesOnEverySessionSource", () => {
    const pluginHooks = readJson("hooks/hooks.json")["hooks"] as Record<string, Array<Record<string, unknown>>>
    for (const event of PRINCIPLES_EVENTS) {
      assert.deepEqual((pluginHooks[event] ?? []).map((group) => group["matcher"]), [undefined], event)
    }
  })

  it("pluginVersion_matchesThePackageVersion", () => {
    assert.equal(readJson(".claude-plugin/plugin.json")["version"], readJson("package.json")["version"])
  })

  it("marketplace_listsThePluginFromTheRepositoryRoot", () => {
    const plugins = readJson(".claude-plugin/marketplace.json")["plugins"] as Array<Record<string, unknown>>
    assert.deepEqual(
      plugins.map((entry) => [entry["name"], entry["source"]]),
      [[readJson(".claude-plugin/plugin.json")["name"], "./"]],
    )
  })
})
