export class PyRegexError extends Error {}

const WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const ASCII_WHITESPACE = "\\t\\n\\v\\f\\r "
const SYNTAX_CHARACTERS = new Set("^$\\.*+?()[]{}|/")
const GLOBAL_FLAGS = /^\(\?([aiLmsux]+)\)/
const QUANTIFIER = /^\{(\d*)(,?)(\d*)\}/
const NAMED_GROUP_OPEN = "(?P<"
const NAMED_BACKREFERENCE = /^\(\?P=([A-Za-z_]\w*)\)/
const COMMENT_GROUP = /^\(\?#[^)]*\)/
const PASSTHROUGH_LETTER_ESCAPES = new Set(["n", "r", "t", "f", "v"])

interface Dialect {
  ignoreCase: boolean
  multiline: boolean
  dotAll: boolean
  ascii: boolean
}

export function compilePythonRegex(pattern: string, flags: string = ""): RegExp {
  const dialect: Dialect = { ignoreCase: flags.includes("i"), multiline: flags.includes("m"), dotAll: flags.includes("s"), ascii: false }
  let body = pattern
  const global = GLOBAL_FLAGS.exec(pattern)
  if (global) {
    applyGlobalFlags(dialect, global[1] ?? "")
    body = pattern.slice(global[0].length)
  }
  try {
    return new RegExp(translate(body, dialect), (dialect.ignoreCase ? "iu" : "u") + (flags.includes("g") ? "g" : ""))
  } catch (error) {
    if (error instanceof PyRegexError) throw error
    throw new PyRegexError(error instanceof Error ? error.message : String(error))
  }
}

function applyGlobalFlags(dialect: Dialect, letters: string): void {
  if (letters.includes("x") || letters.includes("L")) throw new PyRegexError(`unsupported inline flags (?${letters})`)
  dialect.ignoreCase ||= letters.includes("i")
  dialect.multiline ||= letters.includes("m")
  dialect.dotAll ||= letters.includes("s")
  dialect.ascii ||= letters.includes("a")
}

function translate(pattern: string, dialect: Dialect): string {
  const chars = Array.from(pattern)
  let output = ""
  let index = 0
  while (index < chars.length) {
    const char = chars[index] as string
    if (char === "\\") {
      const next = chars[index + 1]
      if (next === undefined) throw new PyRegexError("bad escape (end of pattern)")
      output += translateEscape(next, chars, index, dialect)
      index += next === "x" || next === "u" || next === "U" ? 2 + escapeDigits(next) : 2
    } else if (char === "[") {
      const closing = classEnd(chars, index)
      output += translateClass(chars.slice(index + 1, closing), dialect)
      index = closing + 1
    } else if (char === "(") {
      const rest = chars.slice(index).join("")
      const named = rest.startsWith(NAMED_GROUP_OPEN)
      const backreference = NAMED_BACKREFERENCE.exec(rest)
      const comment = COMMENT_GROUP.exec(rest)
      if (named) {
        output += "(?<"
        index += NAMED_GROUP_OPEN.length
      } else if (backreference) {
        output += `\\k<${backreference[1]}>`
        index += backreference[0].length
      } else if (comment) {
        index += comment[0].length
      } else {
        output += "("
        index++
      }
    } else if (char === "{") {
      const rest = chars.slice(index).join("")
      const quantifier = QUANTIFIER.exec(rest)
      const isQuantifier = quantifier !== null && (quantifier[1] !== "" || quantifier[3] !== "")
      output += isQuantifier ? `{${quantifier?.[1] || "0"}${quantifier?.[2]}${quantifier?.[3]}}` : "\\{"
      index += isQuantifier ? (quantifier?.[0].length ?? 1) : 1
    } else {
      output += translatePlain(char, dialect)
      index++
    }
  }
  return output
}

function translatePlain(char: string, dialect: Dialect): string {
  if (char === ".") return dialect.dotAll ? "[\\s\\S]" : "[^\\n]"
  if (char === "^") return dialect.multiline ? "(?<![^\\n])" : "^"
  if (char === "$") return dialect.multiline ? "(?![^\\n])" : "(?=\\n?(?![\\s\\S]))"
  if (char === "}") return "\\}"
  return char
}

function wordClass(dialect: Dialect): string {
  return dialect.ascii ? "[A-Za-z0-9_]" : "[\\p{L}\\p{N}_]"
}

function escapeDigits(kind: string): number {
  return kind === "x" ? 2 : kind === "u" ? 4 : 8
}

function translateEscape(next: string, chars: string[], index: number, dialect: Dialect): string {
  const word = wordClass(dialect)
  const space = dialect.ascii ? ASCII_WHITESPACE : WHITESPACE
  const digit = dialect.ascii ? "[0-9]" : "\\p{Nd}"
  const notDigit = dialect.ascii ? "[^0-9]" : "\\P{Nd}"
  switch (next) {
    case "d": return digit
    case "D": return notDigit
    case "w": return word
    case "W": return "[^" + word.slice(1)
    case "s": return `[${space}]`
    case "S": return `[^${space}]`
    case "b": return `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`
    case "B": return `(?:(?<=${word})(?=${word})|(?<!${word})(?!${word}))`
    case "A": return "(?<![\\s\\S])"
    case "Z": return "(?![\\s\\S])"
    case "a": return "\\x07"
    case "x": case "u": case "U": return hexEscape(next, chars, index)
    default:
      if (PASSTHROUGH_LETTER_ESCAPES.has(next) || /[0-9]/.test(next)) return "\\" + next
      if (/[A-Za-z]/.test(next)) throw new PyRegexError(`bad escape \\${next}`)
      return literal(next)
  }
}

function hexEscape(kind: string, chars: string[], index: number): string {
  const digits = chars.slice(index + 2, index + 2 + escapeDigits(kind)).join("")
  if (digits.length !== escapeDigits(kind) || !/^[0-9a-fA-F]+$/.test(digits)) throw new PyRegexError(`incomplete escape \\${kind}${digits}`)
  return `\\u{${digits.replace(/^0+(?=.)/, "")}}`
}

function literal(char: string): string {
  return SYNTAX_CHARACTERS.has(char) ? "\\" + char : char
}

function classEnd(chars: string[], start: number): number {
  let index = start + 1
  if (chars[index] === "^") index++
  if (chars[index] === "]") index++
  while (index < chars.length) {
    if (chars[index] === "\\") index++
    else if (chars[index] === "]") return index
    index++
  }
  throw new PyRegexError("unterminated character set")
}

function translateClass(body: string[], dialect: Dialect): string {
  let output = "["
  let index = 0
  if (body[0] === "^") {
    output += "^"
    index++
  }
  for (; index < body.length; index++) {
    const char = body[index] as string
    if (char !== "\\") {
      output += char === "[" || char === "]" ? "\\" + char : char
      continue
    }
    const next = body[++index]
    if (next === undefined) throw new PyRegexError("bad escape (end of pattern)")
    output += translateClassEscape(next, body, index, dialect)
    if (next === "x" || next === "u" || next === "U") index += escapeDigits(next)
  }
  return output + "]"
}

function translateClassEscape(next: string, body: string[], index: number, dialect: Dialect): string {
  const space = dialect.ascii ? ASCII_WHITESPACE : WHITESPACE
  switch (next) {
    case "d": return dialect.ascii ? "0-9" : "\\p{Nd}"
    case "D":
      if (dialect.ascii) throw new PyRegexError("unsupported class escape \\D in ASCII mode")
      return "\\P{Nd}"
    case "w": return dialect.ascii ? "A-Za-z0-9_" : "\\p{L}\\p{N}_"
    case "s": return space
    case "b": return "\\x08"
    case "a": return "\\x07"
    case "x": case "u": case "U": return hexEscape(next, ["", "", ...body.slice(index + 1)], 0)
    default:
      if (next === "W" || next === "S") throw new PyRegexError(`unsupported class escape \\${next}`)
      if (PASSTHROUGH_LETTER_ESCAPES.has(next) || /[0-9]/.test(next)) return "\\" + next
      if (/[A-Za-z]/.test(next)) throw new PyRegexError(`bad escape \\${next}`)
      return next === "-" || SYNTAX_CHARACTERS.has(next) ? "\\" + next : next
  }
}
