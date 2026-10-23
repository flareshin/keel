import fs from "node:fs"
import path from "node:path"

import { InvalidUtf8Error, isFile, readUtf8 } from "../../measure/lib/measurekit/files.ts"
import { isJsonObject, parseJson } from "../../measure/lib/measurekit/json.ts"
import type { JsonObject, JsonValue } from "../../measure/lib/measurekit/json.ts"
import { activeStackNames, StackNameError } from "../../measure/lib/measurekit/ledger.ts"
import { canonicalJson, expandPlaceholders, Refused } from "./config.ts"
import type { KeelPaths } from "./config.ts"
import { childList, childObject, member, objectMember, setMember } from "./members.ts"

export const OWNED_KEYS = ["hooks", "permissions", "env"]
export const LIST_PERMISSION_KEYS = ["allow", "deny", "ask"]

export function loadMergedFragments(paths: KeelPaths): [JsonObject, string[]] {
  const fragments = fragmentPaths(paths).map((path): [string, JsonObject] => [path, loadFragment(path, paths)])
  const merged: JsonObject = {}
  const conflicts: string[] = []
  for (const [source, fragment] of fragments) {
    for (const [event, entries] of Object.entries(objectMember(fragment, "hooks"))) {
      childList(childObject(merged, "hooks"), event).push(...(entries as JsonValue[]))
    }
    for (const [key, value] of Object.entries(objectMember(fragment, "permissions"))) {
      const permissions = childObject(merged, "permissions")
      if (LIST_PERMISSION_KEYS.includes(key)) extendKeepingFirst(childList(permissions, key), value as JsonValue[])
      else setLaterWins(permissions, key, value, `permissions.${key}`, source, conflicts)
    }
    for (const [key, value] of Object.entries(objectMember(fragment, "env"))) {
      setLaterWins(childObject(merged, "env"), key, value, `env.${key}`, source, conflicts)
    }
  }
  return [merged, conflicts]
}

export function fragmentPaths(paths: KeelPaths): string[] {
  const core = path.join(paths.keelHome, "settings", "core.json")
  if (!isFile(core)) throw new Refused(`${core} is missing; without it the merged settings would hold no core hooks`)
  const found = [core]
  for (const name of activeStacks(paths).sort()) {
    const stackSettings = path.join(paths.keelHome, "stacks", name, "settings.json")
    if (!isFile(stackSettings)) throw new Refused(`active stack ${JSON.stringify(name)} has no ${stackSettings}`)
    found.push(stackSettings)
  }
  found.push(...fs.globSync(path.join(paths.overlayDir, "settings", "*.json")).sort())
  return found
}

export function activeStacks(paths: KeelPaths): string[] {
  try {
    return activeStackNames(paths.overlayDir)
  } catch (error) {
    if (error instanceof StackNameError) throw new Refused(error.message)
    throw error
  }
}

function loadFragment(fragmentPath: string, paths: KeelPaths): JsonObject {
  let fragment: JsonValue
  try {
    fragment = parseJson(readUtf8(fragmentPath))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error) throw new Refused(`${fragmentPath}: invalid JSON (${error.message})`)
    throw error
  }
  validateFragmentShape(fragmentPath, fragment)
  return expandStrings(fragment, paths, fragmentPath) as JsonObject
}

function validateFragmentShape(fragmentPath: string, fragment: JsonValue): asserts fragment is JsonObject {
  if (!isJsonObject(fragment)) throw new Refused(`${fragmentPath}: a settings fragment must be a JSON object`)
  const foreign = Object.keys(fragment).filter((key) => !OWNED_KEYS.includes(key)).sort()
  if (foreign.length > 0) throw new Refused(`${fragmentPath}: fragments may hold only ${OWNED_KEYS.join(", ")}; found ${foreign.join(", ")}`)
  for (const key of OWNED_KEYS) {
    const section = member(fragment, key)
    if (section !== undefined && !isJsonObject(section)) throw new Refused(`${fragmentPath}: ${key} must be an object`)
  }
  for (const [event, entries] of Object.entries(objectMember(fragment, "hooks"))) {
    if (!Array.isArray(entries)) throw new Refused(`${fragmentPath}: hooks.${event} must be an array`)
  }
  for (const key of LIST_PERMISSION_KEYS) {
    const rules = member(objectMember(fragment, "permissions"), key)
    if (rules !== undefined && !Array.isArray(rules)) throw new Refused(`${fragmentPath}: permissions.${key} must be an array`)
  }
  for (const [key, value] of Object.entries(objectMember(fragment, "env"))) {
    if (typeof value !== "string") throw new Refused(`${fragmentPath}: env.${key} must be a string`)
  }
}

function expandStrings(value: JsonValue, paths: KeelPaths, where: string): JsonValue {
  if (typeof value === "string") return expandPlaceholders(value, paths, where)
  if (Array.isArray(value)) return value.map((item) => expandStrings(item, paths, where))
  if (isJsonObject(value)) {
    const expanded: JsonObject = {}
    for (const [key, item] of Object.entries(value)) setMember(expanded, key, expandStrings(item, paths, where))
    return expanded
  }
  return value
}

function extendKeepingFirst(target: JsonValue[], additions: JsonValue[]): void {
  const seen = new Set(target.map(canonicalJson))
  for (const item of additions) {
    const key = canonicalJson(item)
    if (!seen.has(key)) {
      seen.add(key)
      target.push(item)
    }
  }
}

function setLaterWins(target: JsonObject, key: string, value: JsonValue, label: string, source: string, conflicts: string[]): void {
  const earlier = member(target, key)
  if (earlier !== undefined && canonicalJson(earlier) !== canonicalJson(value)) conflicts.push(`${label} is overridden by ${source}`)
  setMember(target, key, value)
}
