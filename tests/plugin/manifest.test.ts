import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const KEEL_ROOT = path.resolve(import.meta.dirname, "..", "..")
const LINK_PLACEHOLDER = "{{KEEL}}"
const PLUGIN_ROOT_VARIABLE = "${CLAUDE_PLUGIN_ROOT}"

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(KEEL_ROOT, relativePath), "utf8")) as Record<string, unknown>
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(KEEL_ROOT, relativePath), "utf8")
}

describe("plugin manifest", () => {
  it("pluginHooks_registerTheSameHooksAsTheLinkCoreFragment", () => {
    const linkHooks = readText("settings/core.json").replaceAll(LINK_PLACEHOLDER, PLUGIN_ROOT_VARIABLE)
    assert.deepEqual(readJson("hooks/hooks.json"), JSON.parse(linkHooks))
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
