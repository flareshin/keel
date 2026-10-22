import type { JsonObject, PyValue } from "./pyvalue.ts"

const INSERTION_ORDER = new WeakMap<object, string[]>()

export function setMember(object: JsonObject, key: string, value: PyValue): void {
  const order = insertionOrderOf(object)
  if (!Object.hasOwn(object, key)) order.push(key)
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
}

export function memberKeys(object: JsonObject): string[] {
  const recorded = INSERTION_ORDER.get(object)
  if (recorded === undefined) return Object.keys(object)
  const known = new Set(recorded)
  return [...recorded.filter((key) => Object.hasOwn(object, key)), ...Object.keys(object).filter((key) => !known.has(key))]
}

export function memberEntries(object: JsonObject): [string, PyValue][] {
  return memberKeys(object).map((key) => [key, object[key] as PyValue])
}

function insertionOrderOf(object: JsonObject): string[] {
  let order = INSERTION_ORDER.get(object)
  if (order === undefined) {
    order = Object.keys(object)
    INSERTION_ORDER.set(object, order)
  }
  return order
}
