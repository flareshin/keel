import { setMember } from "../../measure/lib/measurekit/pydict.ts"
import { isJsonObject } from "../../measure/lib/measurekit/pyvalue.ts"
import type { JsonObject, PyValue } from "../../measure/lib/measurekit/pyvalue.ts"

export function member(object: JsonObject, key: string): PyValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined
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

export function childList(parent: JsonObject, key: string): PyValue[] {
  const existing = member(parent, key)
  if (Array.isArray(existing)) return existing
  const created: PyValue[] = []
  setMember(parent, key, created)
  return created
}
