import { isJsonObject } from "../../measure/lib/measurekit/json.ts"
import type { JsonObject, JsonValue } from "../../measure/lib/measurekit/json.ts"

export function member(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

export function setMember(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
}

export function recordsNoBackup(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (isJsonObject(value)) return Object.keys(value).length === 0
  return !value
}

export function objectMember(object: JsonObject, key: string): JsonObject {
  const value = member(object, key)
  return isJsonObject(value) ? value : {}
}

export function childObject(parent: JsonObject, key: string): JsonObject {
  const existing = member(parent, key)
  if (isJsonObject(existing)) return existing
  const created: JsonObject = {}
  setMember(parent, key, created)
  return created
}

export function childList(parent: JsonObject, key: string): JsonValue[] {
  const existing = member(parent, key)
  if (Array.isArray(existing)) return existing
  const created: JsonValue[] = []
  setMember(parent, key, created)
  return created
}
