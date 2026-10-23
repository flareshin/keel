import fs from "node:fs"

import { activeStackNames } from "../../measure/lib/measurekit/ledger.ts"
import { memberEntries, setMember } from "../../measure/lib/measurekit/pydict.ts"
import { ValueError } from "../../measure/lib/measurekit/pyerrors.ts"
import { readText } from "../../measure/lib/measurekit/pyio.ts"
import { JsonDecodeError, pythonJsonLoads } from "../../measure/lib/measurekit/pyjson.ts"
import { isFile, pyJoin } from "../../measure/lib/measurekit/pypath.ts"
import { sortedByCodePoint } from "../../measure/lib/measurekit/pystr.ts"
import { isJsonObject, pyRepr } from "../../measure/lib/measurekit/pyvalue.ts"
import type { JsonObject, PyValue } from "../../measure/lib/measurekit/pyvalue.ts"
import { canonicalJson, expandPlaceholders, Refused } from "./config.ts"
import type { KeelPaths } from "./config.ts"
import { childList, childObject, member, objectMember } from "./members.ts"

export const OWNED_KEYS = ["hooks", "permissions", "env"]
export const LIST_PERMISSION_KEYS = ["allow", "deny", "ask"]

export function loadMergedFragments(paths: KeelPaths): [JsonObject, string[]] {
  const fragments = fragmentPaths(paths).map((path): [string, JsonObject] => [path, loadFragment(path, paths)])
  const merged: JsonObject = {}
  const conflicts: string[] = []
  for (const [source, fragment] of fragments) {
    for (const [event, entries] of memberEntries(objectMember(fragment, "hooks"))) {
      childList(childObject(merged, "hooks"), event).push(...(entries as PyValue[]))
    }
    for (const [key, value] of memberEntries(objectMember(fragment, "permissions"))) {
      const permissions = childObject(merged, "permissions")
      if (LIST_PERMISSION_KEYS.includes(key)) extendKeepingFirst(childList(permissions, key), value as PyValue[])
      else setLaterWins(permissions, key, value, `permissions.${key}`, source, conflicts)
    }
    for (const [key, value] of memberEntries(objectMember(fragment, "env"))) {
      setLaterWins(childObject(merged, "env"), key, value, `env.${key}`, source, conflicts)
    }
  }
  return [merged, conflicts]
}

export function fragmentPaths(paths: KeelPaths): string[] {
  const core = pyJoin(paths.keelHome, "settings", "core.json")
  if (!isFile(core)) throw new Refused(`${core} is missing; without it the merged settings would hold no core hooks`)
  const found = [core]
  for (const name of sortedByCodePoint(activeStacks(paths))) {
    const stackSettings = pyJoin(paths.keelHome, "stacks", name, "settings.json")
    if (!isFile(stackSettings)) throw new Refused(`active stack ${pyRepr(name)} has no ${stackSettings}`)
    found.push(stackSettings)
  }
  found.push(...sortedByCodePoint(fs.globSync(pyJoin(paths.overlayDir, "settings", "*.json"))))
  return found
}

export function activeStacks(paths: KeelPaths): string[] {
  try {
    return activeStackNames(paths.overlayDir)
  } catch (error) {
    if (error instanceof ValueError) throw new Refused(error.message)
    throw error
  }
}

function loadFragment(path: string, paths: KeelPaths): JsonObject {
  let fragment: PyValue
  try {
    fragment = pythonJsonLoads(readText(path))
  } catch (error) {
    if (error instanceof JsonDecodeError) throw new Refused(`${path}: invalid JSON (${error.message})`)
    throw error
  }
  validateFragmentShape(path, fragment)
  return expandStrings(fragment, paths, path) as JsonObject
}

function validateFragmentShape(path: string, fragment: PyValue): asserts fragment is JsonObject {
  if (!isJsonObject(fragment)) throw new Refused(`${path}: a settings fragment must be a JSON object`)
  const foreign = sortedByCodePoint(Object.keys(fragment).filter((key) => !OWNED_KEYS.includes(key)))
  if (foreign.length > 0) throw new Refused(`${path}: fragments may hold only ${OWNED_KEYS.join(", ")}; found ${foreign.join(", ")}`)
  for (const key of OWNED_KEYS) {
    const section = member(fragment, key)
    if (section !== undefined && !isJsonObject(section)) throw new Refused(`${path}: ${key} must be an object`)
  }
  for (const [event, entries] of memberEntries(objectMember(fragment, "hooks"))) {
    if (!Array.isArray(entries)) throw new Refused(`${path}: hooks.${event} must be an array`)
  }
  for (const key of LIST_PERMISSION_KEYS) {
    const rules = member(objectMember(fragment, "permissions"), key)
    if (rules !== undefined && !Array.isArray(rules)) throw new Refused(`${path}: permissions.${key} must be an array`)
  }
  for (const [key, value] of memberEntries(objectMember(fragment, "env"))) {
    if (typeof value !== "string") throw new Refused(`${path}: env.${key} must be a string`)
  }
}

function expandStrings(value: PyValue, paths: KeelPaths, where: string): PyValue {
  if (typeof value === "string") return expandPlaceholders(value, paths, where)
  if (Array.isArray(value)) return value.map((item) => expandStrings(item, paths, where))
  if (isJsonObject(value)) {
    const expanded: JsonObject = {}
    for (const [key, item] of memberEntries(value)) setMember(expanded, key, expandStrings(item, paths, where))
    return expanded
  }
  return value
}

function extendKeepingFirst(target: PyValue[], additions: PyValue[]): void {
  const seen = new Set(target.map(canonicalJson))
  for (const item of additions) {
    const key = canonicalJson(item)
    if (!seen.has(key)) {
      seen.add(key)
      target.push(item)
    }
  }
}

function setLaterWins(target: JsonObject, key: string, value: PyValue, label: string, source: string, conflicts: string[]): void {
  const earlier = member(target, key)
  if (earlier !== undefined && canonicalJson(earlier) !== canonicalJson(value)) conflicts.push(`${label} is overridden by ${source}`)
  setMember(target, key, value)
}
