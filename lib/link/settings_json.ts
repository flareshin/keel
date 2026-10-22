import { createHash } from "node:crypto"
import fs from "node:fs"

import { isCommandHook, iterHookEntries } from "../../measure/lib/measurekit/hook_settings.ts"
import type { Registration } from "../../measure/lib/measurekit/hook_settings.ts"
import { setMember } from "../../measure/lib/measurekit/pydict.ts"
import { encodeStrict } from "../../measure/lib/measurekit/pyio.ts"
import { JsonDecodeError, pythonJsonDumps, pythonJsonLoads, pythonJsonRawDecode, skipJsonWhitespace } from "../../measure/lib/measurekit/pyjson.ts"
import { isFile, pyDirname, pyJoin } from "../../measure/lib/measurekit/pypath.ts"
import { pyStrip, sortedByCodePoint } from "../../measure/lib/measurekit/pystr.ts"
import { isJsonObject, pyTruthy, pyTypeName } from "../../measure/lib/measurekit/pyvalue.ts"
import type { JsonObject, PyValue } from "../../measure/lib/measurekit/pyvalue.ts"
import { utcStamp } from "../../measure/lib/measurekit/pydate.ts"
import { writeTextAtomic, makedirs } from "./atomic.ts"
import { canonicalJson, readText, Refused } from "./config.ts"
import type { KeelPaths } from "./config.ts"
import { OWNED_KEYS } from "./fragments.ts"
import { member, objectMember } from "./members.ts"

export const FILE_NAME = "settings.json"
export const PRE_KEEL_BACKUP = "pre_keel_settings_backup"
export const PRE_KEEL_CLAUDE_MD = "pre_keel_claude_md_backup"
export const RESTORE_OP = "restore-settings"

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
const NO_PRE_KEEL_FILE = "none"
const LINK_STATE_SCHEMA = 1

export class AttributeError extends Error {}

export class RuntimeError extends Error {}

export interface LiveSettings {
  readonly path: string
  readonly text: string
  readonly values: JsonObject
}

interface Member {
  readonly key: string
  readonly keyStart: number
  readonly valueStart: number
  readonly valueEnd: number
  readonly indent: string
}

export function settingsPath(paths: KeelPaths): string {
  return pyJoin(paths.dataDir, FILE_NAME)
}

export function readLiveSettings(path: string): LiveSettings {
  if (!fs.existsSync(path)) return { path, text: "{}\n", values: {} }
  const text = readText(path)
  let values: PyValue
  try {
    values = pythonJsonLoads(text)
  } catch (error) {
    if (error instanceof JsonDecodeError) throw new Refused(`${path}: invalid JSON (${error.message}); fix it by hand first`)
    throw error
  }
  if (!isJsonObject(values)) throw new Refused(`${path}: top level must be a JSON object`)
  return { path, text, values }
}

export function driftedOwnedKeys(live: LiveSettings, merged: JsonObject): string[] {
  const report: string[] = []
  for (const key of OWNED_KEYS) {
    const current = member(live.values, key)
    const wanted = member(merged, key)
    if (wanted === undefined && current !== undefined) report.push(`${key}: declared by no fragment; --write removes it`)
    if (wanted === undefined || canonicalJson(current) === canonicalJson(wanted)) continue
    if (!(isJsonObject(current) && isJsonObject(wanted))) {
      report.push(`${key}: differs`)
      continue
    }
    for (const sub of sortedByCodePoint(new Set([...Object.keys(current), ...Object.keys(wanted)]))) {
      const currentSub = member(current, sub)
      const wantedSub = member(wanted, sub)
      if (canonicalJson(currentSub) !== canonicalJson(wantedSub)) report.push(describeSubDrift(`${key}.${sub}`, currentSub, wantedSub))
    }
  }
  return report
}

export function listDroppedItems(live: JsonObject, merged: JsonObject): string[] {
  const unreadable = OWNED_KEYS.filter((key) => Object.hasOwn(live, key) && !isJsonObject(live[key])).map((key) => `${key} (not an object)`)
  return sortedByCodePoint([...unreadable, ...droppedPermissions(live, merged), ...droppedEnv(live, merged), ...droppedHooks(live, merged)])
}

export function spliceOwnedKeys(text: string, merged: JsonObject): string {
  const [members, closingBrace] = scanTopLevel(text)
  const spliced = members.length > 0 ? rebuildMembers(text, members, closingBrace, merged) : fillEmptyObject(text, closingBrace, merged)
  verifySplice(text, spliced, merged)
  return spliced
}

export function writeSettings(live: LiveSettings, merged: JsonObject, backupPath: string): void {
  if (fs.existsSync(live.path)) writePrivate(backupPath, live.text)
  writeTextAtomic(live.path, spliceOwnedKeys(live.text, merged), existingMode(live.path))
}

export function restorePreKeelSettings(paths: KeelPaths): JsonObject | null {
  const recorded = member(readLinkState(paths), PRE_KEEL_BACKUP)
  const path = settingsPath(paths)
  const preKeelOwned = resolvePreKeelOwnedKeys(recorded)
  if (preKeelOwned === null || !fs.existsSync(path)) return null
  const liveText = readText(path)
  const restored = resolveRestoredSettingsText(liveText, preKeelOwned, recorded as string)
  if (restored === null) return null
  const liveSavedTo = pyJoin(newBackupDir(paths), "settings.before-unlink.json")
  writePrivate(liveSavedTo, liveText)
  writeTextAtomic(path, restored, existingMode(path))
  if (recorded === NO_PRE_KEEL_FILE) return { op: "remove-owned-settings", path, from: null, live_saved_to: liveSavedTo }
  return { op: RESTORE_OP, path, from: recorded as string, live_saved_to: liveSavedTo }
}

export function changedSinceLastWrite(paths: KeelPaths, live: LiveSettings): string[] {
  const recordedDigests = member(readLinkState(paths), "settings_owned_sha256")
  const recorded = asObject(recordedDigests === undefined ? {} : recordedDigests, "items")
  return sortedByCodePoint(Object.keys(recorded).filter((key) => digest(member(live.values, key)) !== recorded[key]))
}

export function recordLastWrite(paths: KeelPaths, merged: JsonObject, backupPath: string | null, claudeMdBackup: string | null): void {
  const previous = readLinkState(paths)
  const ownedDigests: JsonObject = {}
  for (const key of OWNED_KEYS) setMember(ownedDigests, key, digest(member(merged, key)))
  const state: JsonObject = {
    schema: LINK_STATE_SCHEMA,
    settings_owned_sha256: ownedDigests,
    [PRE_KEEL_BACKUP]: firstTruthy(member(previous, PRE_KEEL_BACKUP), preKeelRecord(backupPath)),
    [PRE_KEEL_CLAUDE_MD]: firstTruthy(member(previous, PRE_KEEL_CLAUDE_MD), claudeMdBackup),
  }
  writePrivate(linkStatePath(paths), pythonJsonDumps(state, { indent: 2 }) + "\n")
}

export function newBackupDir(paths: KeelPaths): string {
  return pyJoin(paths.dataDir, "state", "keel", "link-backup", `${utcStamp(new Date(), true)}-${process.pid}`)
}

export function linkStatePath(paths: KeelPaths): string {
  return pyJoin(paths.dataDir, "state", "keel", "link-state.json")
}

export function readLinkState(paths: KeelPaths): JsonObject {
  const path = linkStatePath(paths)
  if (!isFile(path)) return {}
  let state: PyValue
  try {
    state = pythonJsonLoads(readText(path))
  } catch (error) {
    if (error instanceof JsonDecodeError) throw new Refused(`${path}: invalid JSON (${error.message}); delete it to forget the last write`)
    throw error
  }
  return asObject(state, "get")
}

function asObject(value: PyValue, attribute: string): JsonObject {
  if (!isJsonObject(value)) throw new AttributeError(`'${pyTypeName(value)}' object has no attribute '${attribute}'`)
  return value
}

function firstTruthy(first: PyValue | undefined, second: PyValue): PyValue {
  return pyTruthy(first) ? (first as PyValue) : second
}

function preKeelRecord(backupPath: string | null): string | null {
  if (backupPath === null) return null
  return isFile(backupPath) ? backupPath : NO_PRE_KEEL_FILE
}

function resolvePreKeelOwnedKeys(recorded: PyValue | undefined): JsonObject | null {
  if (recorded === NO_PRE_KEEL_FILE) return {}
  if (typeof recorded !== "string" || recorded === "" || !isFile(recorded)) return null
  const preKeel = pythonJsonLoads(readText(recorded))
  const owned: JsonObject = {}
  if (!isJsonObject(preKeel)) return owned
  for (const key of OWNED_KEYS) if (Object.hasOwn(preKeel, key)) setMember(owned, key, preKeel[key] as PyValue)
  return owned
}

function resolveRestoredSettingsText(liveText: string, preKeelOwned: JsonObject, recorded: string): string | null {
  let live: PyValue | null
  try {
    live = pythonJsonLoads(liveText)
  } catch (error) {
    if (!(error instanceof JsonDecodeError)) throw error
    live = null
  }
  if (isJsonObject(live)) return spliceOwnedKeys(liveText, preKeelOwned)
  if (recorded === NO_PRE_KEEL_FILE) return null
  return readText(recorded)
}

function writePrivate(path: string, text: string): void {
  makedirs(pyDirname(path), PRIVATE_DIR_MODE)
  writeTextAtomic(path, text, PRIVATE_FILE_MODE)
}

function existingMode(path: string): number {
  try {
    return fs.statSync(path).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return PRIVATE_FILE_MODE
    throw error
  }
}

function pythonItems(value: PyValue | undefined): PyValue[] {
  if (!pyTruthy(value)) return []
  if (Array.isArray(value)) return value
  if (typeof value === "string") return Array.from(value)
  if (isJsonObject(value)) return Object.keys(value)
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`)
}

function describeSubDrift(label: string, current: PyValue | undefined, wanted: PyValue | undefined): string {
  if (!(Array.isArray(current) || Array.isArray(wanted))) return `${label}: differs`
  const currentList = pythonItems(current)
  const wantedList = pythonItems(wanted)
  const currentSet = new Set(currentList.map(canonicalJson))
  const wantedSet = new Set(wantedList.map(canonicalJson))
  const onlyLive = [...currentSet].filter((item) => !wantedSet.has(item)).length
  const onlyMerged = [...wantedSet].filter((item) => !currentSet.has(item)).length
  return `${label}: live=${currentList.length} merged=${wantedList.length} only_live=${onlyLive} only_merged=${onlyMerged}`
}

function droppedPermissions(live: JsonObject, merged: JsonObject): string[] {
  const livePermissions = objectMember(live, "permissions")
  const wanted = objectMember(merged, "permissions")
  const dropped: string[] = []
  for (const [key, value] of Object.entries(livePermissions)) {
    const label = `permissions.${key}`
    if (Array.isArray(value)) {
      const kept = new Set(pythonItems(member(wanted, key)).map(canonicalJson))
      dropped.push(...value.filter((item) => !kept.has(canonicalJson(item))).map((item) => `${label} ${render(item)}`))
    } else if (canonicalJson(value) !== canonicalJson(member(wanted, key))) {
      dropped.push(`${label} ${render(value)}`)
    }
  }
  return dropped
}

function droppedEnv(live: JsonObject, merged: JsonObject): string[] {
  const liveEnv = objectMember(live, "env")
  const wanted = objectMember(merged, "env")
  const removed = Object.keys(liveEnv).filter((name) => !Object.hasOwn(wanted, name)).map((name) => `env ${name} (removed)`)
  const changed = Object.entries(liveEnv)
    .filter(([name, value]) => Object.hasOwn(wanted, name) && wanted[name] !== value)
    .map(([name]) => `env ${name} (value changed)`)
  return [...removed, ...changed]
}

function droppedHooks(live: JsonObject, merged: JsonObject): string[] {
  const kept = new Set(iterHookEntries(member(merged, "hooks")).map(hookIdentity))
  const dropped = iterHookEntries(member(live, "hooks")).filter((entry) => !kept.has(hookIdentity(entry))).map(hookLabel)
  return [...new Set(dropped)]
}

function hookIdentity(entry: Registration): string {
  return JSON.stringify([entry.event, entry.matcher, canonicalJson(entry.hook)])
}

function hookLabel(entry: Registration): string {
  const shown = isCommandHook(entry.hook) ? entry.command : canonicalJson(entry.hook)
  return `hooks.${entry.event} ${shown}`
}

function render(value: PyValue): string {
  return typeof value === "string" ? value : pythonJsonDumps(value, { sortKeys: true })
}

function scanTopLevel(text: string): [Member[], number] {
  let index = skipJsonWhitespace(text, 0)
  if (text.slice(index, index + 1) !== "{") throw new Refused("settings.json top level must be a JSON object")
  index = skipJsonWhitespace(text, index + 1)
  const members: Member[] = []
  while (text.charAt(index) !== "}") {
    const keyStart = index
    const [key, afterKey] = pythonJsonRawDecode(text, index)
    const valueStart = skipJsonWhitespace(text, skipJsonWhitespace(text, afterKey) + 1)
    const [, valueEnd] = pythonJsonRawDecode(text, valueStart)
    members.push({ key: key as string, keyStart, valueStart, valueEnd, indent: lineIndent(text, keyStart) })
    index = skipJsonWhitespace(text, valueEnd)
    if (text.charAt(index) === ",") index = skipJsonWhitespace(text, index + 1)
  }
  return [members, index]
}

function rebuildMembers(text: string, members: Member[], closingBrace: number, merged: JsonObject): string {
  const indent = (members[0] as Member).indent
  const kept: [string, string][] = []
  members.forEach((current, position) => {
    if (OWNED_KEYS.includes(current.key) && !Object.hasOwn(merged, current.key)) return
    const previous = members[position - 1]
    const separator = previous === undefined ? "" : text.slice(previous.valueEnd, current.keyStart)
    const value = Object.hasOwn(merged, current.key) ? renderValue(merged[current.key] as PyValue, current.indent) : text.slice(current.valueStart, current.valueEnd)
    kept.push([separator, text.slice(current.keyStart, current.valueStart) + value])
  })
  const present = new Set(members.map((current) => current.key))
  for (const key of OWNED_KEYS) {
    if (Object.hasOwn(merged, key) && !present.has(key)) {
      kept.push([",\n" + indent, `${pythonJsonDumps(key)}: ${renderValue(merged[key] as PyValue, indent)}`])
    }
  }
  if (kept.length === 0) return text.slice(0, text.indexOf("{") + 1) + text.slice(closingBrace)
  const head = text.slice(0, (members[0] as Member).keyStart)
  const tail = text.slice((members[members.length - 1] as Member).valueEnd)
  const body = kept.map(([separator, memberText], position) => (position === 0 ? memberText : separator + memberText)).join("")
  return head + body + tail
}

function fillEmptyObject(text: string, closingBrace: number, merged: JsonObject): string {
  const indent = "  "
  const rendered = OWNED_KEYS.filter((key) => Object.hasOwn(merged, key)).map((key) => `${indent}${pythonJsonDumps(key)}: ${renderValue(merged[key] as PyValue, indent)}`)
  if (rendered.length === 0) return text
  return text.slice(0, closingBrace) + "\n" + rendered.join(",\n") + "\n" + text.slice(closingBrace)
}

function verifySplice(original: string, spliced: string, merged: JsonObject): void {
  const expected: JsonObject = {}
  for (const [key, value] of Object.entries(pythonJsonLoads(original) as JsonObject)) if (!OWNED_KEYS.includes(key)) setMember(expected, key, value)
  for (const [key, value] of Object.entries(merged)) setMember(expected, key, value)
  if (canonicalJson(pythonJsonLoads(spliced)) !== canonicalJson(expected)) throw new RuntimeError("settings splice produced different values than the merge")
  if (JSON.stringify(rawSpansOfUnowned(spliced)) !== JSON.stringify(rawSpansOfUnowned(original))) {
    throw new RuntimeError("settings splice changed bytes of a key keel does not own")
  }
}

function rawSpansOfUnowned(text: string): [string, string][] {
  const [members] = scanTopLevel(text)
  return members.filter((current) => !OWNED_KEYS.includes(current.key)).map((current) => [current.key, text.slice(current.valueStart, current.valueEnd)])
}

function renderValue(value: PyValue, indent: string): string {
  return pythonJsonDumps(value, { indent: 2, ensureAscii: false }).replaceAll("\n", "\n" + indent)
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1
  const prefix = text.slice(lineStart, position)
  return pyStrip(prefix) === "" ? prefix : ""
}

function digest(value: PyValue | undefined): string {
  return createHash("sha256").update(encodeStrict(canonicalJson(value))).digest("hex")
}
