export interface ExactInteger {
  readonly rawJSON: string
}

export type JsonValue = null | boolean | number | string | ExactInteger | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

type SourceReviver = (key: string, value: unknown, context: { source?: string }) => unknown

export const JSON_INDENT = 2

const NATIVE_JSON = JSON as JSON & { rawJSON(text: string): ExactInteger; isRawJSON(value: unknown): value is ExactInteger }
const INTEGER_TEXT = /^-?\d+$/

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isExactInteger(value)
}

export function isExactInteger(value: unknown): value is ExactInteger {
  return NATIVE_JSON.isRawJSON(value)
}

export function isJsonNumber(value: unknown): boolean {
  return typeof value === "number" || isExactInteger(value)
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue
}

export function parseJsonKeepingIntegers(text: string): JsonValue {
  const parse = JSON.parse as (text: string, reviver: SourceReviver) => unknown
  return parse(text, (_key, value, context) => (isUnsafeIntegerText(value, context.source) ? NATIVE_JSON.rawJSON(context.source as string) : value)) as JsonValue
}

export function displayText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null)
}

export function sortedKeys(object: object): string[] {
  return Object.keys(object).sort(compareCodePoints)
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (char) => char.codePointAt(0) as number)
  const rightPoints = Array.from(right, (char) => char.codePointAt(0) as number)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number)
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

export function stringifySorted(value: unknown, indent: number = 0): string {
  return serializeSorted(value, indent, "") ?? "null"
}

function isUnsafeIntegerText(value: unknown, source: string | undefined): boolean {
  return typeof value === "number" && !Number.isSafeInteger(value) && source !== undefined && INTEGER_TEXT.test(source)
}

function serializeSorted(value: unknown, indent: number, outerPadding: string): string | undefined {
  if (isExactInteger(value)) return value.rawJSON
  const innerPadding = outerPadding + " ".repeat(indent)
  if (Array.isArray(value)) return bracketed("[", "]", value.map((item) => serializeSorted(item, indent, innerPadding) ?? "null"), indent, outerPadding)
  if (!isJsonObject(value)) return JSON.stringify(value)
  const keySeparator = indent > 0 ? ": " : ":"
  const members = sortedKeys(value).flatMap((key) => {
    const item = serializeSorted(value[key], indent, innerPadding)
    return item === undefined ? [] : [JSON.stringify(key) + keySeparator + item]
  })
  return bracketed("{", "}", members, indent, outerPadding)
}

function bracketed(open: string, close: string, items: string[], indent: number, outerPadding: string): string {
  if (items.length === 0) return open + close
  if (indent === 0) return open + items.join(",") + close
  const innerPadding = outerPadding + " ".repeat(indent)
  return `${open}\n${innerPadding}${items.join(`,\n${innerPadding}`)}\n${outerPadding}${close}`
}
