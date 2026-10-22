import { dataLines } from "./datafiles.ts"
import { GitError, runGit } from "./gitutil.ts"
import { FAIL, PASS, stderrExcerpt, WARN } from "./metrics.ts"
import { isOsError, ValueError } from "./pyerrors.ts"
import { readText } from "./pyio.ts"
import { pythonJsonLoads } from "./pyjson.ts"
import { isFile, pyJoin, pyRelpath, realpath } from "./pypath.ts"
import { isUnder, mainWorktreeOverlay } from "./overlay_checkout.ts"
import { pyStrip } from "./pystr.ts"
import { isJsonObject } from "./pyvalue.ts"
import type { JsonObject, PyValue } from "./pyvalue.ts"
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
  const reviewedFile = pyJoin(ctx.overlayDir, REVIEWED_MODS_FILE)
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
    if (error instanceof TimeoutExpired || isOsError(error)) throw new PluginListUnavailable(`${cli} plugin list --json: ${(error as Error).message}`)
    throw error
  }
  if (completed.returncode !== 0) {
    throw new PluginListUnavailable(`${cli} plugin list --json exited ${completed.returncode}: ${stderrExcerpt(completed)}`)
  }
  let plugins: PyValue
  try {
    plugins = pythonJsonLoads(completed.stdout)
  } catch (error) {
    if (error instanceof ValueError) throw new PluginListUnavailable("plugin list output is not JSON")
    throw error
  }
  if (!isPluginList(plugins)) throw new PluginListUnavailable('plugin list output is not [{"id", "installPath"}, ...]')
  return plugins
}

function isPluginList(value: PyValue): value is JsonObject[] & Plugin[] {
  return Array.isArray(value) && value.every((plugin) => isJsonObject(plugin) && typeof plugin["id"] === "string" && typeof plugin["installPath"] === "string")
}

function reviewedIdsIn(reviewedFile: string): Set<string> {
  if (!isFile(reviewedFile)) return new Set()
  return new Set(dataLines(reviewedFile).map(([, line]) => pyStrip(line)))
}

function isMod(installPath: string): boolean {
  if (!isFile(pyJoin(installPath, "hooks", "hooks.json"))) return false
  const modules = listedModules(installPath)
  return modules === null || modules.length > 0
}

function listedModules(installPath: string): string[] | null {
  let hooks: PyValue
  try {
    hooks = pythonJsonLoads(readText(pyJoin(installPath, "hooks", "hooks.json")))
  } catch (error) {
    if (error instanceof ValueError || isOsError(error)) return null
    throw error
  }
  if (!isJsonObject(hooks)) return null
  const modules = "modules" in hooks ? hooks["modules"] : []
  if (!(Array.isArray(modules) && modules.every((module) => typeof module === "string"))) return null
  return modules as string[]
}

function isCommittedOverlayMod(installPath: string, overlay: string | null): boolean {
  const mod = realpath(installPath)
  const modules = listedModules(mod)
  if (overlay === null || !isUnder(mod, new Set([overlay])) || modules === null) return false
  const moduleFiles = new Set(modules.map((module) => pyRelpath(realpath(pyJoin(mod, "hooks", module)), overlay)))
  const pathspec = ":(literal)" + pyRelpath(mod, overlay)
  let tracked: Set<string>
  let changes: string
  try {
    tracked = new Set(runGit(overlay, ["ls-files", "-z", "--", pathspec]).split("\0"))
    tracked.delete("")
    changes = runGit(overlay, ["status", "--porcelain", "--", pathspec])
  } catch (error) {
    if (error instanceof GitError || isOsError(error)) return false
    throw error
  }
  return tracked.size > 0 && pyStrip(changes) === "" && [...moduleFiles].every((file) => tracked.has(file))
}
