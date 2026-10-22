import fs from "node:fs"

import { iterRegistrations } from "../../measure/lib/measurekit/hook_settings.ts"
import type { Registration } from "../../measure/lib/measurekit/hook_settings.ts"
import { hookRowsInForce, loadLedgersFrom } from "../../measure/lib/measurekit/ledger.ts"
import { encodeStrict } from "../../measure/lib/measurekit/pyio.ts"
import { isFile, isLink, lexists, pyJoin, realpath } from "../../measure/lib/measurekit/pypath.ts"
import { pyStrip } from "../../measure/lib/measurekit/pystr.ts"
import { PyFloat, pyRepr } from "../../measure/lib/measurekit/pyvalue.ts"
import type { JsonObject } from "../../measure/lib/measurekit/pyvalue.ts"
import { runProcess } from "../../measure/lib/measurekit/subprocess.ts"
import { copyFileAtomic, moveAside, replaceWithSymlink, writeTextAtomic } from "./atomic.ts"
import * as claudeMd from "./claude_md.ts"
import { readText, runGit } from "./config.ts"
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
  const path = pyJoin(paths.dataDir, entry.target)
  const backupPath = pyJoin(backupRoot, entry.target)
  const linkNow = () => replaceWithSymlink(entry.source, path)
  if (!fs.existsSync(entry.source)) {
    addProblem(plan, "dangling", path, `source does not exist: ${entry.source}`, BLOCKS_ALWAYS)
  } else if (!lexists(path)) {
    addProblem(plan, "link-missing", path, `should link to ${entry.source}`)
    plan.changes.push({ op: "symlink", path, apply: linkNow })
  } else if (!isLink(path)) {
    addProblem(plan, "target-occupied", path, `a real file or directory is in the way; --force moves it to ${backupPath}`, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "symlink", path, apply: afterMovingAside(path, backupPath, linkNow) })
  } else if (fs.readlinkSync(path) === entry.source) {
    return
  } else if (links.isKeelLink(path, paths)) {
    addProblem(plan, "link-wrong", path, `keel link points at ${fs.readlinkSync(path)}, should be ${entry.source}`)
    plan.changes.push({ op: "replace-link", path, apply: linkNow })
  } else {
    const detail = `foreign link points at ${fs.readlinkSync(path)}, should be ${entry.source}; --force moves it to ${backupPath}`
    addProblem(plan, "link-wrong", path, detail, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "replace-link", path, apply: afterMovingAside(path, backupPath, linkNow) })
  }
}

function planCopy(plan: Plan, entry: links.LinkEntry, paths: KeelPaths, backupRoot: string): void {
  const path = pyJoin(paths.dataDir, entry.target)
  const backupPath = pyJoin(backupRoot, entry.target)
  const copyNow = () => copyFileAtomic(entry.source, path)
  if (!isFile(entry.source)) {
    addProblem(plan, "dangling", path, `source is not a file: ${entry.source}`, BLOCKS_ALWAYS)
  } else if (!lexists(path)) {
    addProblem(plan, "copy-missing", path, `should be a copy of ${entry.source}`)
    plan.changes.push({ op: "copy", path, apply: copyNow })
  } else if (links.isKeelLink(path, paths)) {
    addProblem(plan, "link-instead-of-copy", path, `keel link should be a copy of ${entry.source}`)
    plan.changes.push({ op: "copy", path, apply: copyNow })
  } else if (isLink(path)) {
    const detail = `foreign link points at ${fs.readlinkSync(path)}, should be a copy of ${entry.source}; --force moves it to ${backupPath}`
    addProblem(plan, "link-wrong", path, detail, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "copy", path, apply: afterMovingAside(path, backupPath, copyNow) })
  } else if (!isFile(path)) {
    addProblem(plan, "target-occupied", path, `a directory is in the way; --force moves it to ${backupPath}`, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "copy", path, apply: afterMovingAside(path, backupPath, copyNow) })
  } else if (!fs.readFileSync(entry.source).equals(fs.readFileSync(path))) {
    const detail = `differs from ${entry.source}; --force moves it to ${backupPath} and copies the source`
    addProblem(plan, "copy-drift", path, detail, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "copy", path, apply: afterMovingAside(path, backupPath, copyNow) })
  }
}

function planClaudeMd(plan: Plan, paths: KeelPaths, backupRoot: string): void {
  const path = pyJoin(paths.dataDir, claudeMd.FILE_NAME)
  const content = claudeMd.buildClaudeMd(paths)
  const writeNow = () => writeTextAtomic(path, content, CLAUDE_MD_MODE)
  plan.claudeMdBytes = encodeStrict(content).length
  if (plan.claudeMdBytes > claudeMd.MAX_BYTES) {
    const detail = `generated CLAUDE.md would be ${plan.claudeMdBytes} bytes, over the ${claudeMd.MAX_BYTES}-byte cap`
    addProblem(plan, "claude-md-drift", path, detail, BLOCKS_ALWAYS)
  } else if (!lexists(path)) {
    addProblem(plan, "claude-md-drift", path, "generated CLAUDE.md is missing")
    plan.changes.push({ op: "write-claude-md", path, apply: writeNow })
  } else if (!claudeMd.isGeneratedClaudeMd(path)) {
    const backupPath = pyJoin(backupRoot, claudeMd.FILE_NAME)
    plan.claudeMdBackup = backupPath
    addProblem(plan, "target-occupied", path, `not a keel-generated CLAUDE.md; --force moves it to ${backupPath}`, BLOCKS_UNLESS_FORCED)
    plan.changes.push({ op: "write-claude-md", path, apply: afterMovingAside(path, backupPath, writeNow) })
  } else if (readText(path) !== content) {
    addProblem(plan, "claude-md-drift", path, "generated CLAUDE.md is drifted")
    plan.changes.push({ op: "write-claude-md", path, apply: writeNow })
  }
}

function afterMovingAside(path: string, backupPath: string, then: () => void): () => void {
  return () => {
    moveAside(path, backupPath)
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
  const settingsBackup = pyJoin(backupRoot, settingsJson.FILE_NAME)
  plan.settingsBackup = settingsBackup
  plan.changes.push({ op: "merge-settings", path: live.path, apply: () => settingsJson.writeSettings(live, mergedSettings, settingsBackup) })
}

function checkHookWiring(plan: Plan, paths: KeelPaths): void {
  const stacks = activeStacks(paths)
  const registrations = iterRegistrations(member(plan.mergedSettings, "hooks"))
  const registered = new Set(registrations.map((registration) => registration.hookName))
  const ledgerPath = pyJoin(paths.keelHome, "ledger.tsv")
  for (const row of hookRowsInForce(loadLedgersFrom(paths.keelHome, paths.overlayDir), stacks)) {
    if (!registered.has(row.hookName as string)) {
      const detail = `${row.id} (${row.source} ledger): hook ${row.hookName} is not registered in the merged settings`
      addProblem(plan, "hook-unregistered", ledgerPath, detail, BLOCKS_ALWAYS)
    }
  }
  const corePath = pyJoin(paths.keelHome, "settings", "core.json")
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
  const timeout = hook["timeout"]
  const isNumber = typeof timeout === "number" || typeof timeout === "bigint" || timeout instanceof PyFloat
  return hook["onFailure"] === FAIL_CLOSED && isNumber
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
  const current = pyStrip(runGit(keelHome, "config", "--get", "core.hooksPath") ?? "")
  if (current === HOOKS_PATH) return
  addProblem(plan, "hookspath-drift", keelHome, `core.hooksPath is ${current || "unset"}, should be ${HOOKS_PATH}`)
  plan.changes.push({ op: "set-hooks-path", path: keelHome, apply: () => setHooksPath(keelHome) })
}

function setHooksPath(keelHome: string): void {
  const command = ["git", "-C", keelHome, "config", "core.hooksPath", HOOKS_PATH]
  const result = runProcess(command)
  if (result.returncode !== 0) throw new CalledProcessError(`Command '${pyRepr(command)}' returned non-zero exit status ${result.returncode}.`)
}

function isCheckoutRoot(keelHome: string): boolean {
  const toplevel = runGit(keelHome, "rev-parse", "--show-toplevel")
  return toplevel !== null && realpath(pyStrip(toplevel)) === realpath(keelHome)
}
