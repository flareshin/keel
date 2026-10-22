const WHITESPACE_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const LEADING_WHITESPACE = new RegExp(`^[${WHITESPACE_CLASS}]+`, "u")
const TRAILING_WHITESPACE = new RegExp(`[${WHITESPACE_CLASS}]+$`, "u")
const WHITESPACE_RUN = new RegExp(`[${WHITESPACE_CLASS}]+`, "u")
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]", "u")

export function pyStrip(text: string): string {
  return text.replace(LEADING_WHITESPACE, "").replace(TRAILING_WHITESPACE, "")
}

export function pyLstrip(text: string): string {
  return text.replace(LEADING_WHITESPACE, "")
}

export function pySplitWhitespace(text: string): string[] {
  return pyStrip(text).split(WHITESPACE_RUN).filter((word) => word !== "")
}

export function pySplitlines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (char) => char.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (char) => char.codePointAt(0) ?? 0)
  const shared = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < shared; index++) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

export function sortedByCodePoint(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints)
}

export function firstCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("")
}

export function codePointLength(text: string): number {
  let length = 0
  for (const _ of text) length++
  return length
}

const DECIMAL_DIGIT = /^\p{Nd}$/u

export function digitValue(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0
  if (codePoint < 0x80) return codePoint - 0x30
  let runStart = codePoint
  while (DECIMAL_DIGIT.test(String.fromCodePoint(runStart - 1))) runStart--
  return (codePoint - runStart) % 10
}

export function pyInt(digits: string): number {
  let value = 0
  for (const char of digits) value = value * 10 + digitValue(char)
  return value
}

const INTEGER_TEXT = /^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u

export function pyIntOrNull(text: string): number | null {
  const stripped = pyStrip(text)
  if (!INTEGER_TEXT.test(stripped)) return null
  return pyInt(stripped.replace(/^[+-]/, "").replaceAll("_", "")) * (stripped.startsWith("-") ? -1 : 1)
}
