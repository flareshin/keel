export interface ExactInteger {
  readonly rawJSON: string
}

export type JsonValue = null | boolean | number | string | ExactInteger | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

type SourceReviver = (key: string, value: unknown, context: { source?: string }) => unknown

export const JSON_INDENT = 2
export const MAX_JSON_DEPTH = 10000

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
  const plain = JSON.parse(text) as JsonValue
  if (!holdsNumberPastSafeIntegers(plain)) return plain
  const parse = JSON.parse as (text: string, reviver: SourceReviver) => unknown
  return parse(text, (_key, value, context) => (isUnsafeIntegerText(value, context.source) ? NATIVE_JSON.rawJSON(context.source as string) : value)) as JsonValue
}

export function nestsPastMaxJsonDepth(text: string): boolean {
  let depth = 0
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (character === "\\") index += 1
      else if (character === '"') inString = false
    } else if (character === '"') {
      inString = true
    } else if (character === "[" || character === "{") {
      depth += 1
      if (depth > MAX_JSON_DEPTH) return true
    } else if (character === "]" || character === "}") {
      depth -= 1
    }
  }
  return false
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
  return serializeSorted(value, indent) ?? "null"
}

function holdsNumberPastSafeIntegers(value: JsonValue): boolean {
  const pending: JsonValue[] = [value]
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item === "number" && Math.abs(item) > Number.MAX_SAFE_INTEGER) return true
    if (Array.isArray(item)) for (const child of item) pending.push(child)
    else if (isJsonObject(item)) for (const child of Object.values(item)) pending.push(child)
  }
  return false
}

function isUnsafeIntegerText(value: unknown, source: string | undefined): boolean {
  return typeof value === "number" && !Number.isSafeInteger(value) && source !== undefined && INTEGER_TEXT.test(source)
}

interface OpenContainer {
  readonly close: string
  readonly entries: Array<[label: string, value: unknown]>
  readonly padding: string
  next: number
}

function serializeSorted(root: unknown, indent: number): string | undefined {
  if (!isContainer(root)) return scalarText(root)
  const parts: string[] = []
  const open: OpenContainer[] = [openContainer(root, "", indent, parts)]
  while (open.length > 0) {
    const container = open.at(-1) as OpenContainer
    if (container.next === container.entries.length) {
      open.pop()
      if (indent > 0 && container.entries.length > 0) parts.push("\n" + container.padding)
      parts.push(container.close)
      continue
    }
    const [label, value] = container.entries[container.next] as [string, unknown]
    const innerPadding = container.padding + " ".repeat(indent)
    parts.push((container.next > 0 ? "," : "") + (indent > 0 ? "\n" + innerPadding : "") + label)
    container.next += 1
    if (isContainer(value)) open.push(openContainer(value, innerPadding, indent, parts))
    else parts.push(scalarText(value) ?? "null")
  }
  return parts.join("")
}

function isContainer(value: unknown): value is unknown[] | JsonObject {
  return Array.isArray(value) || isJsonObject(value)
}

function openContainer(value: unknown[] | JsonObject, padding: string, indent: number, parts: string[]): OpenContainer {
  if (Array.isArray(value)) {
    parts.push("[")
    return { close: "]", entries: value.map((item) => ["", item]), padding, next: 0 }
  }
  parts.push("{")
  const keySeparator = indent > 0 ? ": " : ":"
  const writable = sortedKeys(value).filter((key) => isContainer(value[key]) || scalarText(value[key]) !== undefined)
  return { close: "}", entries: writable.map((key) => [JSON.stringify(key) + keySeparator, value[key]]), padding, next: 0 }
}

function scalarText(value: unknown): string | undefined {
  return isExactInteger(value) ? value.rawJSON : JSON.stringify(value)
}
