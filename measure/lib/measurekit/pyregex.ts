export class PyRegexError extends Error {}

const WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const ASCII_WHITESPACE = "\\t\\n\\v\\f\\r "
const SYNTAX_CHARACTERS = new Set("^$\\.*+?()[]{}|/")
const GLOBAL_FLAGS = /^\(\?([aiLmsux]+)\)/
const SCOPED_FLAGS = /^\(\?([aiLmsux]*)(?:-([imsx]+))?:/
const LOOKBEHIND_OPEN = /^\(\?<[=!]/
const QUANTIFIER = /^\{(\d*)(,?)(\d*)\}/
const NAMED_GROUP_OPEN = /^\(\?P<([^>]*)>/
const NAMED_BACKREFERENCE = /^\(\?P=([A-Za-z_]\w*)\)/
const COMMENT_GROUP = /^\(\?#[^)]*\)/
const CONTROL_ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b, a: 0x07 }
const MAX_CODE_POINT = 0x10ffff
const MAX_OCTAL_ESCAPE = 0o377
const I_FAMILY = ["i", "I", "İ", "ı"]
const I_FAMILY_MEMBERS = "iI\\u0130\\u0131"
const I_FAMILY_CLASS = `[${I_FAMILY_MEMBERS}]`

interface Dialect {
  ignoreCase: boolean
  multiline: boolean
  dotAll: boolean
  ascii: boolean
}

interface Escape {
  text: string
  length: number
}

interface ClassItem {
  text: string
  length: number
  isSet: boolean
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

function scopedDialect(outer: Dialect, added: string, removed: string): Dialect {
  if (added.includes("x") || added.includes("L")) throw new PyRegexError(`unsupported inline flags (?${added}:`)
  if (added.includes("a") && added.includes("u")) throw new PyRegexError("bad inline flags: flags 'a', 'u' and 'L' are incompatible")
  if ([...added].some((letter) => removed.includes(letter))) throw new PyRegexError("bad inline flags: flag turned on and off")
  const flagIn = (letter: string, current: boolean): boolean => (added.includes(letter) ? true : removed.includes(letter) ? false : current)
  return {
    ignoreCase: flagIn("i", outer.ignoreCase),
    multiline: flagIn("m", outer.multiline),
    dotAll: flagIn("s", outer.dotAll),
    ascii: added.includes("a") || outer.ascii,
  }
}

function translate(pattern: string, start: Dialect): string {
  const chars = Array.from(pattern)
  const enclosingDialects: Dialect[] = []
  let dialect = start
  let output = ""
  let index = 0
  while (index < chars.length) {
    const char = chars[index] as string
    if (char === "\\") {
      const escape = translateEscape(chars, index + 1, dialect)
      output += escape.text
      index += 1 + escape.length
    } else if (char === "[") {
      const closing = classEnd(chars, index)
      output += translateClass(chars.slice(index + 1, closing), dialect)
      index = closing + 1
    } else if (char === "(") {
      const rest = chars.slice(index).join("")
      const backreference = NAMED_BACKREFERENCE.exec(rest)
      const comment = COMMENT_GROUP.exec(rest)
      if (backreference) {
        output += `\\k<${backreference[1]}>`
        index += backreference[0].length
      } else if (comment) {
        index += comment[0].length
      } else {
        const group = openGroup(rest, dialect)
        enclosingDialects.push(dialect)
        dialect = group.dialect
        output += group.text
        index += group.length
      }
    } else if (char === ")") {
      const enclosing = enclosingDialects.pop()
      if (enclosing === undefined) throw new PyRegexError("unbalanced parenthesis")
      dialect = enclosing
      output += ")"
      index++
    } else if (char === "{") {
      const rest = chars.slice(index).join("")
      const quantifier = QUANTIFIER.exec(rest)
      const isQuantifier = quantifier !== null && quantifier[0] !== "{}"
      output += isQuantifier ? `{${quantifier?.[1] || "0"}${quantifier?.[2]}${quantifier?.[3]}}` : "\\{"
      index += isQuantifier ? (quantifier?.[0].length ?? 1) : 1
    } else {
      output += translatePlain(char, dialect)
      index++
    }
  }
  return output
}

function openGroup(rest: string, dialect: Dialect): { text: string; length: number; dialect: Dialect } {
  const named = NAMED_GROUP_OPEN.exec(rest)
  if (named) return { text: `(?<${named[1]}>`, length: named[0].length, dialect }
  if (rest.startsWith("(?<") && !LOOKBEHIND_OPEN.test(rest)) throw new PyRegexError("unknown extension ?<")
  const scoped = SCOPED_FLAGS.exec(rest)
  if (!scoped) return { text: "(", length: 1, dialect }
  const inner = scopedDialect(dialect, scoped[1] ?? "", scoped[2] ?? "")
  const caseModifier = inner.ignoreCase === dialect.ignoreCase ? "" : inner.ignoreCase ? "i" : "-i"
  return { text: `(?${caseModifier}:`, length: scoped[0].length, dialect: inner }
}

function translatePlain(char: string, dialect: Dialect): string {
  if (char === ".") return dialect.dotAll ? "[\\s\\S]" : "[^\\n]"
  if (char === "^") return dialect.multiline ? "(?<![^\\n])" : "^"
  if (char === "$") return dialect.multiline ? "(?![^\\n])" : "(?=\\n?(?![\\s\\S]))"
  if (char === "}" || char === "]") return "\\" + char
  return foldedLiteral(char, dialect)
}

function foldsIFamily(dialect: Dialect): boolean {
  return dialect.ignoreCase && !dialect.ascii
}

function foldedLiteral(char: string, dialect: Dialect): string {
  return foldsIFamily(dialect) && I_FAMILY.includes(char) ? I_FAMILY_CLASS : char
}

function codePointLiteral(codePoint: number, dialect: Dialect): string {
  return foldsIFamily(dialect) && I_FAMILY.includes(String.fromCodePoint(codePoint)) ? I_FAMILY_CLASS : codePointEscape(codePoint)
}

function codePointEscape(codePoint: number): string {
  return `\\u{${codePoint.toString(16)}}`
}

function wordClass(dialect: Dialect): string {
  return dialect.ascii ? "[A-Za-z0-9_]" : "[\\p{L}\\p{N}_]"
}

function escapeDigits(kind: string): number {
  return kind === "x" ? 2 : kind === "u" ? 4 : 8
}

function isOctalDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "7"
}

function isDecimalDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9"
}

function translateEscape(chars: string[], at: number, dialect: Dialect): Escape {
  const next = chars[at]
  if (next === undefined) throw new PyRegexError("bad escape (end of pattern)")
  const word = wordClass(dialect)
  const space = dialect.ascii ? ASCII_WHITESPACE : WHITESPACE
  const digit = dialect.ascii ? "[0-9]" : "\\p{Nd}"
  const notDigit = dialect.ascii ? "[^0-9]" : "\\P{Nd}"
  switch (next) {
    case "d": return { text: digit, length: 1 }
    case "D": return { text: notDigit, length: 1 }
    case "w": return { text: word, length: 1 }
    case "W": return { text: "[^" + word.slice(1), length: 1 }
    case "s": return { text: `[${space}]`, length: 1 }
    case "S": return { text: `[^${space}]`, length: 1 }
    case "b": return { text: `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`, length: 1 }
    case "B": return { text: `(?:(?<=${word})(?=${word})|(?<!${word})(?!${word}))`, length: 1 }
    case "A": return { text: "(?<![\\s\\S])", length: 1 }
    case "Z": return { text: "(?![\\s\\S])", length: 1 }
    case "x": case "u": case "U": return { text: codePointLiteral(hexCodePoint(next, chars, at + 1), dialect), length: 1 + escapeDigits(next) }
    default:
      if (next in CONTROL_ESCAPES) return { text: codePointEscape(CONTROL_ESCAPES[next] as number), length: 1 }
      if (isDecimalDigit(next)) return translateNumericEscape(chars, at, dialect)
      if (/[A-Za-z]/.test(next)) throw new PyRegexError(`bad escape \\${next}`)
      return { text: SYNTAX_CHARACTERS.has(next) ? "\\" + next : foldedLiteral(next, dialect), length: 1 }
  }
}

function translateNumericEscape(chars: string[], at: number, dialect: Dialect): Escape {
  const first = chars[at] as string
  const second = chars[at + 1]
  if (first === "0") {
    const octal = octalDigitsFrom(chars, at, 3)
    return { text: codePointLiteral(Number.parseInt(octal, 8), dialect), length: octal.length }
  }
  if (isOctalDigit(first) && isOctalDigit(second) && isOctalDigit(chars[at + 2])) {
    return { text: codePointLiteral(octalCodePoint(octalDigitsFrom(chars, at, 3)), dialect), length: 3 }
  }
  const reference = isDecimalDigit(second) ? first + second : first
  return { text: `(?:\\${reference})`, length: reference.length }
}

function octalDigitsFrom(chars: string[], at: number, limit: number): string {
  let digits = ""
  while (digits.length < limit && isOctalDigit(chars[at + digits.length])) digits += chars[at + digits.length]
  return digits
}

function octalCodePoint(digits: string): number {
  const codePoint = Number.parseInt(digits, 8)
  if (codePoint > MAX_OCTAL_ESCAPE) throw new PyRegexError(`octal escape value \\${digits} outside of range 0-0o377`)
  return codePoint
}

function hexCodePoint(kind: string, chars: string[], start: number): number {
  const digits = chars.slice(start, start + escapeDigits(kind)).join("")
  if (digits.length !== escapeDigits(kind) || !/^[0-9a-fA-F]+$/.test(digits)) throw new PyRegexError(`incomplete escape \\${kind}${digits}`)
  const codePoint = Number.parseInt(digits, 16)
  if (codePoint > MAX_CODE_POINT) throw new PyRegexError(`bad escape \\${kind}${digits}`)
  return codePoint
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
  const negated = body[0] === "^"
  const members = translateClassMembers(negated ? body.slice(1) : body, dialect)
  const withIFamily = foldsIFamily(dialect) && classContainsIFamily(members) ? members + I_FAMILY_MEMBERS : members
  return `(?:[${negated ? "^" : ""}${withIFamily}])`
}

function classContainsIFamily(members: string): boolean {
  const probe = new RegExp(`[${members}]`, "u")
  return I_FAMILY.some((char) => probe.test(char))
}

function translateClassMembers(body: string[], dialect: Dialect): string {
  let members = ""
  let index = 0
  while (index < body.length) {
    const low = classItem(body, index, dialect)
    index += low.length
    if (body[index] !== "-" || index + 1 >= body.length) {
      members += low.text
      continue
    }
    const high = classItem(body, index + 1, dialect)
    if (low.isSet || high.isSet) throw new PyRegexError("bad character range")
    members += `${low.text}-${high.text}`
    index += 1 + high.length
  }
  return members
}

function classItem(body: string[], index: number, dialect: Dialect): ClassItem {
  const char = body[index] as string
  if (char === "\\") return classEscape(body, index + 1, dialect)
  return { text: classLiteral(char), length: 1, isSet: false }
}

function classLiteral(char: string): string {
  return char === "-" || char === "[" || char === "]" || char === "^" || char === "\\" ? "\\" + char : char
}

function classEscape(body: string[], at: number, dialect: Dialect): ClassItem {
  const next = body[at]
  if (next === undefined) throw new PyRegexError("bad escape (end of pattern)")
  const space = dialect.ascii ? ASCII_WHITESPACE : WHITESPACE
  const set = (text: string): ClassItem => ({ text, length: 2, isSet: true })
  const literalCodePoint = (codePoint: number, length: number): ClassItem => ({ text: codePointEscape(codePoint), length, isSet: false })
  switch (next) {
    case "d": return set(dialect.ascii ? "0-9" : "\\p{Nd}")
    case "D":
      if (dialect.ascii) throw new PyRegexError("unsupported class escape \\D in ASCII mode")
      return set("\\P{Nd}")
    case "w": return set(dialect.ascii ? "A-Za-z0-9_" : "\\p{L}\\p{N}_")
    case "s": return set(space)
    case "b": return literalCodePoint(0x08, 2)
    case "x": case "u": case "U": return literalCodePoint(hexCodePoint(next, body, at + 1), 2 + escapeDigits(next))
    default:
      if (next === "W" || next === "S") throw new PyRegexError(`unsupported class escape \\${next}`)
      if (next in CONTROL_ESCAPES) return literalCodePoint(CONTROL_ESCAPES[next] as number, 2)
      if (isOctalDigit(next)) {
        const octal = octalDigitsFrom(body, at, 3)
        return literalCodePoint(octalCodePoint(octal), 1 + octal.length)
      }
      if (/[A-Za-z0-9]/.test(next)) throw new PyRegexError(`bad escape \\${next}`)
      return { text: classLiteral(next), length: 2, isSet: false }
  }
}
