import fs from "node:fs"
import path from "node:path"

import { entryExists, isFile, isSymlink, readUtf8, resolveLinks } from "../../measure/lib/measurekit/files.ts"
import { iterRegistrations } from "../../measure/lib/measurekit/hook_settings.ts"
import type { Registration } from "../../measure/lib/measurekit/hook_settings.ts"
import type { JsonObject } from "../../measure/lib/measurekit/json.ts"
import { hookRowsInForce, loadLedgersFrom } from "../../measure/lib/measurekit/ledger.ts"
import { runProcess } from "../../measure/lib/measurekit/subprocess.ts"
import { copyFileAtomic, moveAside, replaceWithSymlink, writeTextAtomic } from "./atomic.ts"
import * as claudeMd from "./claude_md.ts"
import { runGit } from "./config.ts"
import type { KeelPaths } from "./config.ts"
import { OWNED_KEYS, activeStacks, loadMergedFragments } from "./fragments.ts"
import * as links from "./links.ts"
import { member } from "./members.ts"
import * as settingsJson from "./settings_json.ts"

export const BLOCKS_NEVER = "never"
export const BLOCKS_UNLESS_FORCED = "unless-forced"
export const BLOCKS_UNLESS_ADOPTED = "unless-adopted"
export const BLOCKS_ALWAYS = "always"
export const FORCE_FLAG = "--force"
export const ADOPT_FLAG = "--adopt"

export type BlockLevel = typeof BLOCKS_NEVER | typeof BLOCKS_UNLESS_FORCED | typeof BLOCKS_UNLESS_ADOPTED | typeof BLOCKS_ALWAYS

export const LIFTING_FLAGS: Record<BlockLevel, readonly string[] | null> = {
  [BLOCKS_NEVER]: [],
  [BLOCKS_UNLESS_ADOPTED]: [ADOPT_FLAG],
  [BLOCKS_UNLESS_FORCED]: [FORCE_FLAG],
  [BLOCKS_ALWAYS]: null,
}

const CLAUDE_MD_MODE = 0o644
const HOOKS_PATH = "githooks"
const FAIL_CLOSED = "block"
const GATED_TOOLS: Record<string, string[]> = {
  "ship-gate": ["Bash"],
  "git-guard": ["Bash", "Edit", "Write", "NotebookEdit"],
}

export class CalledProcessError extends Error {}

export interface Problem {
  readonly kind: string
  readonly path: string
  readonly detail: string
  readonly blocksWrite: BlockLevel
}

export interface Change {
  readonly op: string
  readonly path: string
  readonly apply: () => void
}

export interface Plan {
  changes: Change[]
  problems: Problem[]
  mergedSettings: JsonObject
  settingsBackup: string | null
  droppedSettings: string[]
  claudeMdBytes: number
  claudeMdBackup: string | null
  conflicts: string[]
}

export function problemBlocks(problem: Problem, force: boolean, adopt: boolean): boolean {
  const lifting = LIFTING_FLAGS[problem.blocksWrite]
  const given = new Set([...(force ? [FORCE_FLAG] : []), ...(adopt ? [ADOPT_FLAG] : [])])
  return lifting === null || !lifting.every((flag) => given.has(flag))
}

export function problemToJson(problem: Problem): JsonObject {
  return { kind: problem.kind, path: problem.path, detail: problem.detail }
}

export function changeToJson(change: Change): JsonObject {
  return { op: change.op, path: change.path }
}

export function buildPlan(paths: KeelPaths): Plan {
  const plan: Plan = {
    changes: [], problems: [], mergedSettings: {}, settingsBackup: null, droppedSettings: [], claudeMdBytes: 0, claudeMdBackup: null, conflicts: [],
  }
  const backupRoot = settingsJson.newBackupDir(paths)
  for (const entry of links.readLinkManifest(paths)) {
    if (links.isCopied(entry)) planCopy(plan, entry, paths, backupRoot)
    else planLink(plan, entry, paths, backupRoot)
  }
  planClaudeMd(plan, paths, backupRoot)
  planSettings(plan, paths, backupRoot)
  planHooksPath(plan, paths)
  return plan
}

function addProblem(plan: Plan, kind: string, path: string, detail: string, blocksWrite: BlockLevel = BLOCKS_NEVER): void {
  plan.problems.push({ kind, path, detail, blocksWrite })
}

function planLink(plan: Plan, entry: links.LinkEntry, paths: KeelPaths, backupRoot: string): void {
  const target = path.join(paths.dataDir, entry.target)
  const backupPath = path.join(backupRoot, entry.target)
  const linkNow = () => replaceWithSymlink(entry.source, target)
  if (!fs.existsSync(entry.source)) {
    addProblem(plan, "dangling", target, `source does not exist: ${entry.source}`, BLOCKS_ALWAYS)
  } else if (!entryExists(target)) {
    addProblem(plan, "link-missing", target, `should link to ${entry.source}`)
    plan.changes.push({ op: "symlink", path: target, apply: linkNow })
  } else if (!isSymlink(target)) {
    addProblem(plan, "target-occupied", target, `a real file or directory is in the way; --force moves it to ${backupPath}`, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "symlink", path: target, apply: afterMovingAside(target, backupPath, linkNow) })
  } else if (fs.readlinkSync(target) === entry.source) {
    return
  } else if (links.isKeelLink(target, paths)) {
    addProblem(plan, "link-wrong", target, `keel link points at ${fs.readlinkSync(target)}, should be ${entry.source}`)
    plan.changes.push({ op: "replace-link", path: target, apply: linkNow })
  } else {
    const detail = `foreign link points at ${fs.readlinkSync(target)}, should be ${entry.source}; --force moves it to ${backupPath}`
    addProblem(plan, "link-wrong", target, detail, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "replace-link", path: target, apply: afterMovingAside(target, backupPath, linkNow) })
  }
}

function planCopy(plan: Plan, entry: links.LinkEntry, paths: KeelPaths, backupRoot: string): void {
  const target = path.join(paths.dataDir, entry.target)
  const backupPath = path.join(backupRoot, entry.target)
  const copyNow = () => copyFileAtomic(entry.source, target)
  if (!isFile(entry.source)) {
    addProblem(plan, "dangling", target, `source is not a file: ${entry.source}`, BLOCKS_ALWAYS)
  } else if (!entryExists(target)) {
    addProblem(plan, "copy-missing", target, `should be a copy of ${entry.source}`)
    plan.changes.push({ op: "copy", path: target, apply: copyNow })
  } else if (links.isKeelLink(target, paths)) {
    addProblem(plan, "link-instead-of-copy", target, `keel link should be a copy of ${entry.source}`)
    plan.changes.push({ op: "copy", path: target, apply: copyNow })
  } else if (isSymlink(target)) {
    const detail = `foreign link points at ${fs.readlinkSync(target)}, should be a copy of ${entry.source}; --force moves it to ${backupPath}`
    addProblem(plan, "link-wrong", target, detail, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "copy", path: target, apply: afterMovingAside(target, backupPath, copyNow) })
  } else if (!isFile(target)) {
    addProblem(plan, "target-occupied", target, `a directory is in the way; --force moves it to ${backupPath}`, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "copy", path: target, apply: afterMovingAside(target, backupPath, copyNow) })
  } else if (!fs.readFileSync(entry.source).equals(fs.readFileSync(target))) {
    const detail = `differs from ${entry.source}; --force moves it to ${backupPath} and copies the source`
    addProblem(plan, "copy-drift", target, detail, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "copy", path: target, apply: afterMovingAside(target, backupPath, copyNow) })
  }
}

function planClaudeMd(plan: Plan, paths: KeelPaths, backupRoot: string): void {
  const claudeMdPath = path.join(paths.dataDir, claudeMd.FILE_NAME)
  const content = claudeMd.buildClaudeMd(paths)
  const writeNow = () => writeTextAtomic(claudeMdPath, content, CLAUDE_MD_MODE)
  plan.claudeMdBytes = Buffer.byteLength(content, "utf8")
  if (plan.claudeMdBytes > claudeMd.MAX_BYTES) {
    const detail = `generated CLAUDE.md would be ${plan.claudeMdBytes} bytes, over the ${claudeMd.MAX_BYTES}-byte cap`
    addProblem(plan, "claude-md-drift", claudeMdPath, detail, BLOCKS_ALWAYS)
  } else if (!entryExists(claudeMdPath)) {
    addProblem(plan, "claude-md-drift", claudeMdPath, "generated CLAUDE.md is missing")
    plan.changes.push({ op: "write-claude-md", path: claudeMdPath, apply: writeNow })
  } else if (!claudeMd.isGeneratedClaudeMd(claudeMdPath)) {
    const backupPath = path.join(backupRoot, claudeMd.FILE_NAME)
    plan.claudeMdBackup = backupPath
    addProblem(plan, "target-occupied", claudeMdPath, `not a keel-generated CLAUDE.md; --force moves it to ${backupPath}`, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "write-claude-md", path: claudeMdPath, apply: afterMovingAside(claudeMdPath, backupPath, writeNow) })
  } else if (readUtf8(claudeMdPath) !== content) {
    addProblem(plan, "claude-md-drift", claudeMdPath, "generated CLAUDE.md is drifted")
    plan.changes.push({ op: "write-claude-md", path: claudeMdPath, apply: writeNow })
  }
}

function afterMovingAside(file: string, backupPath: string, then: () => void): () => void {
  return () => {
    moveAside(file, backupPath)
    then()
  }
}

function planSettings(plan: Plan, paths: KeelPaths, backupRoot: string): void {
  const [mergedSettings, conflicts] = loadMergedFragments(paths)
  plan.mergedSettings = mergedSettings
  plan.conflicts = conflicts
  checkHookWiring(plan, paths)
  const live = settingsJson.readLiveSettings(settingsJson.settingsPath(paths))
  const drift = settingsJson.driftedOwnedKeys(live, plan.mergedSettings)
  if (drift.length === 0) return
  const editedByHand = settingsJson.changedSinceLastWrite(paths, live)
  const blocks = editedByHand.length > 0 ? BLOCKS_UNLESS_FORCED : BLOCKS_NEVER
  let detail = drift.join("; ")
  if (editedByHand.length > 0) detail += `; ${editedByHand.join(", ")} changed since the last --write (--force overwrites)`
  addProblem(plan, "settings-drift", live.path, detail, blocks)
  if (isFirstWriteOverOwnedKeys(paths, live)) {
    plan.droppedSettings = settingsJson.listDroppedItems(live.values, plan.mergedSettings)
    const unadoptedDetail = `keel has never written these owned keys; the dry run and --write --adopt list the ${plan.droppedSettings.length} items it would drop`
    addProblem(plan, "settings-unadopted", live.path, unadoptedDetail, BLOCKS_UNLESS_ADOPTED)
  }
  const settingsBackup = path.join(backupRoot, settingsJson.FILE_NAME)
  plan.settingsBackup = settingsBackup
  plan.changes.push({ op: "merge-settings", path: live.path, apply: () => settingsJson.writeSettings(live, mergedSettings, settingsBackup) })
}

function checkHookWiring(plan: Plan, paths: KeelPaths): void {
  const stacks = activeStacks(paths)
  const registrations = iterRegistrations(member(plan.mergedSettings, "hooks"))
  const registered = new Set(registrations.map((registration) => registration.hookName))
  const ledgerPath = path.join(paths.keelHome, "ledger.tsv")
  for (const row of hookRowsInForce(loadLedgersFrom(paths.keelHome, paths.overlayDir), stacks)) {
    if (!registered.has(row.hookName as string)) {
      const detail = `${row.id} (${row.source} ledger): hook ${row.hookName} is not registered in the merged settings`
      addProblem(plan, "hook-unregistered", ledgerPath, detail, BLOCKS_ALWAYS)
    }
  }
  const corePath = path.join(paths.keelHome, "settings", "core.json")
  for (const registration of registrations) {
    if (isGate(registration) && !failsClosed(registration.hook)) {
      const detail = `PreToolUse[${registration.matcher}] ${registration.hookName}: needs "onFailure": "${FAIL_CLOSED}" and a numeric "timeout"`
      addProblem(plan, "gate-onfailure-missing", corePath, detail)
    }
  }
}

function isGate(registration: Registration): boolean {
  const tools = Object.hasOwn(GATED_TOOLS, registration.hookName) ? (GATED_TOOLS[registration.hookName] as string[]) : []
  return registration.event === "PreToolUse" && tools.some((tool) => registration.coversTool(tool))
}

function failsClosed(hook: JsonObject): boolean {
  return hook["onFailure"] === FAIL_CLOSED && typeof hook["timeout"] === "number"
}

function isFirstWriteOverOwnedKeys(paths: KeelPaths, live: settingsJson.LiveSettings): boolean {
  return !isFile(settingsJson.linkStatePath(paths)) && OWNED_KEYS.some((key) => Object.hasOwn(live.values, key))
}

function planHooksPath(plan: Plan, paths: KeelPaths): void {
  const keelHome = paths.keelHome
  if (!isCheckoutRoot(keelHome)) {
    addProblem(plan, "hookspath-drift", keelHome, "KEEL_HOME is not the root of a git checkout; githooks cannot be installed", BLOCKS_ALWAYS)
    return
  }
  const current = (runGit(keelHome, "config", "--get", "core.hooksPath") ?? "").trim()
  if (current === HOOKS_PATH) return
  addProblem(plan, "hookspath-drift", keelHome, `core.hooksPath is ${current || "unset"}, should be ${HOOKS_PATH}`)
  plan.changes.push({ op: "set-hooks-path", path: keelHome, apply: () => setHooksPath(keelHome) })
}

function setHooksPath(keelHome: string): void {
  const command = ["git", "-C", keelHome, "config", "core.hooksPath", HOOKS_PATH]
  const configRun = runProcess(command)
  if (configRun.returncode !== 0) throw new CalledProcessError(`command ${JSON.stringify(command)} exited ${configRun.returncode}`)
}

function isCheckoutRoot(keelHome: string): boolean {
  const toplevel = runGit(keelHome, "rev-parse", "--show-toplevel")
  return toplevel !== null && resolveLinks(toplevel.trim()) === resolveLinks(keelHome)
}
