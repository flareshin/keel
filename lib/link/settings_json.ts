import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { compactUtcSeconds } from "../../measure/lib/measurekit/dates.ts"
import { isFile, readUtf8 } from "../../measure/lib/measurekit/files.ts"
import { isCommandHook, iterHookEntries } from "../../measure/lib/measurekit/hook_settings.ts"
import type { Registration } from "../../measure/lib/measurekit/hook_settings.ts"
import { isJsonObject, parseJson } from "../../measure/lib/measurekit/json.ts"
import type { JsonObject, JsonValue } from "../../measure/lib/measurekit/json.ts"
import { writeTextAtomic, makedirs } from "./atomic.ts"
import { canonicalJson, Refused } from "./config.ts"
import type { KeelPaths } from "./config.ts"
import { OWNED_KEYS } from "./fragments.ts"
import { skipWhitespace, valueEnd } from "./json_spans.ts"
import { member, objectMember, setMember } from "./members.ts"

export const FILE_NAME = "settings.json"
export const PRE_KEEL_BACKUP = "pre_keel_settings_backup"
export const PRE_KEEL_CLAUDE_MD = "pre_keel_claude_md_backup"
export const RESTORE_OP = "restore-settings"

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
const NO_PRE_KEEL_FILE = "none"
const LINK_STATE_SCHEMA = 1
const JSON_INDENT = 2

export class LinkStateError extends Error {}

export class SpliceError extends Error {}

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
  return path.join(paths.dataDir, FILE_NAME)
}

export function readLiveSettings(file: string): LiveSettings {
  if (!fs.existsSync(file)) return { path: file, text: "{}\n", values: {} }
  const text = readUtf8(file)
  let values: JsonValue
  try {
    values = parseJson(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Refused(`${file}: invalid JSON (${error.message}); fix it by hand first`)
    throw error
  }
  if (!isJsonObject(values)) throw new Refused(`${file}: top level must be a JSON object`)
  return { path: file, text, values }
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
    for (const sub of [...new Set([...Object.keys(current), ...Object.keys(wanted)])].sort()) {
      const currentSub = member(current, sub)
      const wantedSub = member(wanted, sub)
      if (canonicalJson(currentSub) !== canonicalJson(wantedSub)) report.push(describeSubDrift(`${key}.${sub}`, currentSub, wantedSub))
    }
  }
  return report
}

export function listDroppedItems(live: JsonObject, merged: JsonObject): string[] {
  const unreadable = OWNED_KEYS.filter((key) => Object.hasOwn(live, key) && !isJsonObject(live[key])).map((key) => `${key} (not an object)`)
  return [...unreadable, ...droppedPermissions(live, merged), ...droppedEnv(live, merged), ...droppedHooks(live, merged)].sort()
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
  const recorded = recordedSettingsBackup(paths)
  const file = settingsPath(paths)
  const preKeelOwned = resolvePreKeelOwnedKeys(recorded)
  if (preKeelOwned === null || !fs.existsSync(file)) return null
  const liveText = readUtf8(file)
  const restored = resolveRestoredSettingsText(liveText, preKeelOwned, recorded as string)
  if (restored === null) return null
  const liveSavedTo = path.join(newBackupDir(paths), "settings.before-unlink.json")
  writePrivate(liveSavedTo, liveText)
  writeTextAtomic(file, restored, existingMode(file))
  if (recorded === NO_PRE_KEEL_FILE) return { op: "remove-owned-settings", path: file, from: null, live_saved_to: liveSavedTo }
  return { op: RESTORE_OP, path: file, from: recorded as string, live_saved_to: liveSavedTo }
}

export function changedSinceLastWrite(paths: KeelPaths, live: LiveSettings): string[] {
  const recordedDigests = member(readLinkState(paths), "settings_owned_sha256")
  const recorded = recordedDigests === undefined ? {} : asLinkStateObject(recordedDigests, "settings_owned_sha256")
  return Object.keys(recorded).filter((key) => digest(member(live.values, key)) !== recorded[key]).sort()
}

export function recordLastWrite(paths: KeelPaths, merged: JsonObject, backupPath: string | null, claudeMdBackup: string | null): void {
  const previous = readLinkState(paths)
  const ownedDigests: JsonObject = {}
  for (const key of OWNED_KEYS) setMember(ownedDigests, key, digest(member(merged, key)))
  const state: JsonObject = {
    schema: LINK_STATE_SCHEMA,
    settings_owned_sha256: ownedDigests,
    [PRE_KEEL_BACKUP]: member(previous, PRE_KEEL_BACKUP) || preKeelRecord(backupPath),
    [PRE_KEEL_CLAUDE_MD]: member(previous, PRE_KEEL_CLAUDE_MD) || claudeMdBackup,
  }
  writePrivate(linkStatePath(paths), JSON.stringify(state, null, JSON_INDENT) + "\n")
}

export function newBackupDir(paths: KeelPaths): string {
  return path.join(paths.dataDir, "state", "keel", "link-backup", `${compactUtcSeconds(new Date())}-${process.pid}`)
}

export function linkStatePath(paths: KeelPaths): string {
  return path.join(paths.dataDir, "state", "keel", "link-state.json")
}

export function readLinkState(paths: KeelPaths): JsonObject {
  const file = linkStatePath(paths)
  if (!isFile(file)) return {}
  let state: JsonValue
  try {
    state = parseJson(readUtf8(file))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Refused(`${file}: invalid JSON (${error.message}); delete it to forget the last write`)
    throw error
  }
  return asLinkStateObject(state, "the link state")
}

function asLinkStateObject(value: JsonValue, what: string): JsonObject {
  if (!isJsonObject(value)) throw new LinkStateError(`${what} is not a JSON object`)
  return value
}

function preKeelRecord(backupPath: string | null): string | null {
  if (backupPath === null) return null
  return isFile(backupPath) ? backupPath : NO_PRE_KEEL_FILE
}

function recordedSettingsBackup(paths: KeelPaths): string | null | undefined {
  const recorded = member(readLinkState(paths), PRE_KEEL_BACKUP)
  if (recorded === undefined || recorded === null || typeof recorded === "string") return recorded
  throw new TypeError(`${linkStatePath(paths)}: ${PRE_KEEL_BACKUP} must be a string, got ${Array.isArray(recorded) ? "array" : typeof recorded}`)
}

function resolvePreKeelOwnedKeys(recorded: string | null | undefined): JsonObject | null {
  if (recorded === NO_PRE_KEEL_FILE) return {}
  if (!recorded || !isFile(recorded)) return null
  const preKeel = parseJson(readUtf8(recorded))
  if (Array.isArray(preKeel) || typeof preKeel === "string") return ownedKeysOfNonObjectBackup(preKeel, recorded)
  if (!isJsonObject(preKeel)) throw new TypeError(`${recorded}: the pre-keel settings backup is not a JSON object`)
  const owned: JsonObject = {}
  for (const key of OWNED_KEYS) if (Object.hasOwn(preKeel, key)) setMember(owned, key, preKeel[key] as JsonValue)
  return owned
}

function ownedKeysOfNonObjectBackup(preKeel: JsonValue[] | string, recorded: string): JsonObject {
  const named = OWNED_KEYS.filter((key) => preKeel.includes(key))
  if (named.length > 0) throw new TypeError(`${recorded}: the pre-keel settings backup is not a JSON object but names ${named.join(", ")}`)
  return {}
}

function resolveRestoredSettingsText(liveText: string, preKeelOwned: JsonObject, recorded: string): string | null {
  let live: JsonValue | null
  try {
    live = parseJson(liveText)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    live = null
  }
  if (isJsonObject(live)) return spliceOwnedKeys(liveText, preKeelOwned)
  if (recorded === NO_PRE_KEEL_FILE) return null
  return readUtf8(recorded)
}

function writePrivate(file: string, text: string): void {
  makedirs(path.dirname(file), PRIVATE_DIR_MODE)
  writeTextAtomic(file, text, PRIVATE_FILE_MODE)
}

function existingMode(file: string): number {
  try {
    return fs.statSync(file).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return PRIVATE_FILE_MODE
    throw error
  }
}

function listItems(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function describeSubDrift(label: string, current: JsonValue | undefined, wanted: JsonValue | undefined): string {
  if (!(Array.isArray(current) || Array.isArray(wanted))) return `${label}: differs`
  const currentList = listItems(current)
  const wantedList = listItems(wanted)
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
      const kept = new Set(listItems(member(wanted, key)).map(canonicalJson))
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

function render(value: JsonValue): string {
  return typeof value === "string" ? value : canonicalJson(value)
}

function scanTopLevel(text: string): [Member[], number] {
  let index = skipWhitespace(text, 0)
  if (text.slice(index, index + 1) !== "{") throw new Refused("settings.json top level must be a JSON object")
  index = skipWhitespace(text, index + 1)
  const members: Member[] = []
  while (text.charAt(index) !== "}") {
    const keyStart = index
    const afterKey = valueEnd(text, keyStart)
    const key = JSON.parse(text.slice(keyStart, afterKey)) as string
    const valueStart = skipWhitespace(text, skipWhitespace(text, afterKey) + 1)
    const end = valueEnd(text, valueStart)
    members.push({ key, keyStart, valueStart, valueEnd: end, indent: lineIndent(text, keyStart) })
    index = skipWhitespace(text, end)
    if (text.charAt(index) === ",") index = skipWhitespace(text, index + 1)
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
    const value = Object.hasOwn(merged, current.key) ? renderValue(merged[current.key] as JsonValue, current.indent) : text.slice(current.valueStart, current.valueEnd)
    kept.push([separator, text.slice(current.keyStart, current.valueStart) + value])
  })
  const present = new Set(members.map((current) => current.key))
  for (const key of OWNED_KEYS) {
    if (Object.hasOwn(merged, key) && !present.has(key)) {
      kept.push([",\n" + indent, `${JSON.stringify(key)}: ${renderValue(merged[key] as JsonValue, indent)}`])
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
  const rendered = OWNED_KEYS.filter((key) => Object.hasOwn(merged, key)).map((key) => `${indent}${JSON.stringify(key)}: ${renderValue(merged[key] as JsonValue, indent)}`)
  if (rendered.length === 0) return text
  return text.slice(0, closingBrace) + "\n" + rendered.join(",\n") + "\n" + text.slice(closingBrace)
}

function verifySplice(original: string, spliced: string, merged: JsonObject): void {
  const expected: JsonObject = {}
  for (const [key, value] of Object.entries(parseJson(original) as JsonObject)) if (!OWNED_KEYS.includes(key)) setMember(expected, key, value)
  for (const [key, value] of Object.entries(merged)) setMember(expected, key, value)
  if (canonicalJson(parseJson(spliced)) !== canonicalJson(expected)) throw new SpliceError("settings splice produced different values than the merge")
  if (JSON.stringify(rawSpansOfUnowned(spliced)) !== JSON.stringify(rawSpansOfUnowned(original))) {
    throw new SpliceError("settings splice changed bytes of a key keel does not own")
  }
}

function rawSpansOfUnowned(text: string): [string, string][] {
  const [members] = scanTopLevel(text)
  return members.filter((current) => !OWNED_KEYS.includes(current.key)).map((current) => [current.key, text.slice(current.valueStart, current.valueEnd)])
}

function renderValue(value: JsonValue, indent: string): string {
  return JSON.stringify(value, null, JSON_INDENT).replaceAll("\n", "\n" + indent)
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1
  const prefix = text.slice(lineStart, position)
  return prefix.trim() === "" ? prefix : ""
}

function digest(value: JsonValue | undefined): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}
