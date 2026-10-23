export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue
}

export function displayText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null)
}

export function stringifySorted(value: unknown, indent?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => (isJsonObject(item) ? withSortedKeys(item) : item), indent)
}

function withSortedKeys(object: JsonObject): JsonObject {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key] as JsonValue]))
}
