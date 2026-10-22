import { compareCodePoints } from "./pystr.ts"
import { ValueError } from "./pyerrors.ts"
import { PyFloat, pyFloatRepr } from "./pyvalue.ts"
import type { PyValue } from "./pyvalue.ts"

export class JsonDecodeError extends ValueError {}

export interface DumpOptions {
  sortKeys?: boolean
  indent?: number
  ensureAscii?: boolean
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"])
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
const LITERALS: Array<[string, PyValue]> = [
  ["null", null], ["true", true], ["false", false],
  ["NaN", new PyFloat(Number.NaN)], ["Infinity", new PyFloat(Number.POSITIVE_INFINITY)], ["-Infinity", new PyFloat(Number.NEGATIVE_INFINITY)],
]

export function pythonJsonLoads(text: string): PyValue {
  const reader = new Reader(text)
  if (text.startsWith("\ufeff")) throw reader.fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0)
  reader.skipWhitespace()
  const value = reader.readValue()
  reader.skipWhitespace()
  if (!reader.atEnd()) throw reader.fail("Extra data", reader.position)
  return value
}

export function pythonJsonRawDecode(text: string, index: number): [PyValue, number] {
  const reader = new Reader(text)
  reader.position = index
  const value = reader.readValue()
  return [value, reader.position]
}

export function pythonJsonDumps(value: object | PyValue, options: DumpOptions = {}): string {
  return dump(value as PyValue, options, 0)
}

class Reader {
  readonly text: string
  position = 0

  constructor(text: string) {
    this.text = text
  }

  fail(message: string, position: number): JsonDecodeError {
    const lastNewline = this.text.lastIndexOf("\n", position - 1)
    const line = this.text.slice(0, position).split("\n").length
    const column = lastNewline < 0 ? position + 1 : position - lastNewline
    return new JsonDecodeError(`${message}: line ${line} column ${column} (char ${position})`)
  }

  atEnd(): boolean {
    return this.position >= this.text.length
  }

  skipWhitespace(): void {
    while (!this.atEnd() && JSON_WHITESPACE.has(this.text.charAt(this.position))) this.position++
  }

  readValue(): PyValue {
    const char = this.text.charAt(this.position)
    if (char === "{") return this.readObject()
    if (char === "[") return this.readArray()
    if (char === '"') return this.readString()
    for (const [literal, value] of LITERALS) {
      if (this.text.startsWith(literal, this.position)) {
        this.position += literal.length
        return value
      }
    }
    return this.readNumber()
  }

  private readNumber(): PyValue {
    NUMBER_PATTERN.lastIndex = this.position
    const match = NUMBER_PATTERN.exec(this.text)
    if (!match) throw this.fail("Expecting value", this.position)
    this.position += match[0].length
    if (match[1] !== undefined || match[2] !== undefined) return new PyFloat(Number(match[0]))
    const asNumber = Number(match[0])
    return Number.isSafeInteger(asNumber) ? asNumber : BigInt(match[0])
  }

  private readString(): string {
    const start = this.position++
    let result = ""
    for (;;) {
      if (this.atEnd()) throw this.fail("Unterminated string starting at", start)
      const char = this.text.charAt(this.position++)
      if (char === '"') return result
      if (char < " ") throw this.fail("Invalid control character at", this.position - 1)
      result += char === "\\" ? this.readEscape() : char
    }
  }

  private readEscape(): string {
    const backslash = this.position - 1
    const code = this.text.charAt(this.position++)
    if (code === "u") {
      const hex = this.text.slice(this.position, this.position + 4)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail("Invalid \\uXXXX escape", backslash + 1)
      this.position += 4
      return String.fromCharCode(Number.parseInt(hex, 16))
    }
    const simple = SIMPLE_ESCAPES[code]
    if (simple === undefined) throw this.fail("Invalid \\escape", backslash)
    return simple
  }

  private readArray(): PyValue[] {
    this.position++
    const items: PyValue[] = []
    this.skipWhitespace()
    if (this.text.charAt(this.position) === "]") {
      this.position++
      return items
    }
    let commaAt = -1
    for (;;) {
      this.skipWhitespace()
      if (commaAt >= 0 && this.text.charAt(this.position) === "]") throw this.fail("Illegal trailing comma before end of array", commaAt)
      items.push(this.readValue())
      this.skipWhitespace()
      const separator = this.text.charAt(this.position++)
      if (separator === "]") return items
      if (separator !== ",") throw this.fail("Expecting ',' delimiter", this.position - 1)
      commaAt = this.position - 1
    }
  }

  private readObject(): { [key: string]: PyValue } {
    this.position++
    const members: { [key: string]: PyValue } = {}
    this.skipWhitespace()
    if (this.text.charAt(this.position) === "}") {
      this.position++
      return members
    }
    let commaAt = -1
    for (;;) {
      this.skipWhitespace()
      if (commaAt >= 0 && this.text.charAt(this.position) === "}") throw this.fail("Illegal trailing comma before end of object", commaAt)
      if (this.text.charAt(this.position) !== '"') throw this.fail("Expecting property name enclosed in double quotes", this.position)
      const key = this.readString()
      this.skipWhitespace()
      if (this.text.charAt(this.position++) !== ":") throw this.fail("Expecting ':' delimiter", this.position - 1)
      this.skipWhitespace()
      Object.defineProperty(members, key, { value: this.readValue(), enumerable: true, writable: true, configurable: true })
      this.skipWhitespace()
      const separator = this.text.charAt(this.position++)
      if (separator === "}") return members
      if (separator !== ",") throw this.fail("Expecting ',' delimiter", this.position - 1)
      commaAt = this.position - 1
    }
  }
}

function dump(value: PyValue, options: DumpOptions, depth: number): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : dumpFloat(value)
  if (value instanceof PyFloat) return dumpFloat(value.value)
  if (typeof value === "string") return dumpString(value, options)
  if (Array.isArray(value)) return dumpContainer(value.map((item) => dump(item, options, depth + 1)), "[", "]", options, depth)
  const keys = Object.keys(value)
  if (options.sortKeys) keys.sort(compareCodePoints)
  const separator = ": "
  const members = keys.map((key) => dumpString(key, options) + separator + dump(value[key] as PyValue, options, depth + 1))
  return dumpContainer(members, "{", "}", options, depth)
}

function dumpContainer(items: string[], open: string, close: string, options: DumpOptions, depth: number): string {
  if (items.length === 0) return open + close
  if (options.indent === undefined) return open + items.join(", ") + close
  const inner = "\n" + " ".repeat(options.indent * (depth + 1))
  const outer = "\n" + " ".repeat(options.indent * depth)
  return open + inner + items.join("," + inner) + outer + close
}

function dumpFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN"
  if (!Number.isFinite(value)) return value < 0 ? "-Infinity" : "Infinity"
  return pyFloatRepr(value)
}

const NAMED_ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" }

function dumpString(text: string, options: DumpOptions): string {
  const escapeNonAscii = options.ensureAscii ?? true
  let escaped = ""
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    const codeUnit = text.charCodeAt(index)
    const named = NAMED_ESCAPES[char]
    if (named !== undefined) escaped += named
    else if (codeUnit < 0x20 || (escapeNonAscii && codeUnit > 0x7e)) escaped += `\\u${codeUnit.toString(16).padStart(4, "0")}`
    else escaped += char
  }
  return `"${escaped}"`
}
