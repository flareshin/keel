import path from "node:path"

import { dataLines } from "./datafiles.ts"
import { InvalidUtf8Error, isFile, isSystemError, readUtf8, resolveLinks } from "./files.ts"
import { GitError, runGit } from "./gitutil.ts"
import { isJsonObject, parseJson } from "./json.ts"
import type { JsonObject, JsonValue } from "./json.ts"
import { FAIL, PASS, stderrExcerpt, WARN } from "./metrics.ts"
import { isUnder, mainWorktreeOverlay } from "./overlay_checkout.ts"
import { runProcess, TimeoutExpired } from "./subprocess.ts"
import { assertion, firstItems } from "./smoke_context.ts"
import type { Assertion, SmokeContext } from "./smoke_context.ts"

const REVIEWED_MODS_FILE = "reviewed-mods.txt"
const PLUGIN_LIST_TIMEOUT_SECONDS = 60

class PluginListUnavailable extends Error {}

interface Plugin {
  id: string
  installPath: string
}

export function checkModTrust(ctx: SmokeContext): Assertion[] {
  let plugins: Plugin[]
  try {
    plugins = installedPlugins()
  } catch (error) {
    if (error instanceof PluginListUnavailable) return [assertion("mod-trust", "all", WARN, `mod check could not run: ${error.message}`)]
    throw error
  }
  const reviewedFile = path.join(ctx.overlayDir, REVIEWED_MODS_FILE)
  const reviewedIds = reviewedIdsIn(reviewedFile)
  const mainOverlay = mainWorktreeOverlay(ctx.overlayDir)
  const mods = plugins.filter((plugin) => isMod(plugin.installPath))
  const unreviewed = mods
    .filter((plugin) => !reviewedIds.has(plugin.id) && !isCommittedOverlayMod(plugin.installPath, mainOverlay))
    .map((plugin) => plugin.id)
  if (unreviewed.length > 0) {
    const detail = `unreviewed mods: ${firstItems(unreviewed)}; read each with \`claude plugin validate <installPath>\`, then add its id to ${reviewedFile} or uninstall it`
    return [assertion("mod-trust", "all", FAIL, detail)]
  }
  return [assertion("mod-trust", "all", PASS, `no unreviewed mod among ${plugins.length} plugins (${mods.length} mods)`)]
}

function installedPlugins(): Plugin[] {
  const cli = process.env["KEEL_CLAUDE"] || "claude"
  let completed
  try {
    completed = runProcess([cli, "plugin", "list", "--json"], { stdin: "ignore", timeoutSeconds: PLUGIN_LIST_TIMEOUT_SECONDS })
  } catch (error) {
    if (error instanceof TimeoutExpired || isSystemError(error)) throw new PluginListUnavailable(`${cli} plugin list --json: ${(error as Error).message}`)
    throw error
  }
  if (completed.returncode !== 0) {
    throw new PluginListUnavailable(`${cli} plugin list --json exited ${completed.returncode}: ${stderrExcerpt(completed)}`)
  }
  let plugins: JsonValue
  try {
    plugins = parseJson(completed.stdout)
  } catch (error) {
    if (error instanceof SyntaxError) throw new PluginListUnavailable("plugin list output is not JSON")
    throw error
  }
  if (!isPluginList(plugins)) throw new PluginListUnavailable('plugin list output is not [{"id", "installPath"}, ...]')
  return plugins
}

function isPluginList(value: JsonValue): value is JsonObject[] & Plugin[] {
  return Array.isArray(value) && value.every((plugin) => isJsonObject(plugin) && typeof plugin["id"] === "string" && typeof plugin["installPath"] === "string")
}

function reviewedIdsIn(reviewedFile: string): Set<string> {
  if (!isFile(reviewedFile)) return new Set()
  return new Set(dataLines(reviewedFile).map(([, line]) => line.trim()))
}

function isMod(installPath: string): boolean {
  if (!isFile(path.join(installPath, "hooks", "hooks.json"))) return false
  const modules = listedModules(installPath)
  return modules === null || modules.length > 0
}

function listedModules(installPath: string): string[] | null {
  let hooks: JsonValue
  try {
    hooks = parseJson(readUtf8(path.join(installPath, "hooks", "hooks.json")))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error || isSystemError(error)) return null
    throw error
  }
  if (!isJsonObject(hooks)) return null
  const modules = "modules" in hooks ? hooks["modules"] : []
  if (!(Array.isArray(modules) && modules.every((module) => typeof module === "string"))) return null
  return modules as string[]
}

function isCommittedOverlayMod(installPath: string, overlay: string | null): boolean {
  const mod = resolveLinks(installPath)
  const modules = listedModules(mod)
  if (overlay === null || !isUnder(mod, new Set([overlay])) || modules === null) return false
  const moduleFiles = new Set(modules.map((module) => path.relative(overlay, resolveLinks(path.join(mod, "hooks", module)))))
  const pathspec = ":(literal)" + (path.relative(overlay, mod) || ".")
  let tracked: Set<string>
  let changes: string
  try {
    tracked = new Set(runGit(overlay, ["ls-files", "-z", "--", pathspec]).split("\0"))
    tracked.delete("")
    changes = runGit(overlay, ["status", "--porcelain", "--", pathspec])
  } catch (error) {
    if (error instanceof GitError || isSystemError(error)) return false
    throw error
  }
  return tracked.size > 0 && changes.trim() === "" && [...moduleFiles].every((file) => tracked.has(file))
}
