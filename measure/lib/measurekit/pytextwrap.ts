import { ValueError } from "./pyerrors.ts"
import { codePointLength, pyStrip } from "./pystr.ts"

const WHITESPACE = "[\\t\\n\\x0b\\x0c\\r ]"
const NOT_WHITESPACE = "[^\\t\\n\\x0b\\x0c\\r ]"
const WORD = "[\\p{L}\\p{N}_]"
const WORD_PUNCTUATION = "[\\p{L}\\p{N}_!\"'&.,?]"
const LETTER = "[\\p{L}\\p{Nl}\\p{No}_]"

const WORD_SEPARATOR = new RegExp(
  `(${WHITESPACE}+` +
    `|(?<=${WORD_PUNCTUATION})-{2,}(?=${WORD})` +
    `|${NOT_WHITESPACE}+?(?:` +
    `-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})` +
    `|(?=${WHITESPACE}|$)` +
    `|(?<=${WORD_PUNCTUATION})(?=-{2,}${WORD})))`,
  "u",
)
const WHITESPACE_CHARACTERS = /[\t\n\x0b\x0c\r]/g
const TAB_SIZE = 8

export function wrapText(text: string, width: number, initialIndent = "", subsequentIndent = ""): string[] {
  const chunks = expandTabs(text).replace(WHITESPACE_CHARACTERS, " ").split(WORD_SEPARATOR).filter((chunk) => chunk !== "")
  return wrapChunks(chunks, width, initialIndent, subsequentIndent)
}

function expandTabs(text: string): string {
  let expanded = ""
  let column = 0
  for (const character of text) {
    if (character === "\t") {
      const spaces = TAB_SIZE - (column % TAB_SIZE)
      expanded += " ".repeat(spaces)
      column += spaces
    } else {
      expanded += character
      column = character === "\n" || character === "\r" ? 0 : column + 1
    }
  }
  return expanded
}

export function fillText(text: string, width: number, indent: string): string {
  return wrapText(text, width, indent, indent).join("\n")
}

function wrapChunks(chunks: string[], totalWidth: number, initialIndent: string, subsequentIndent: string): string[] {
  if (totalWidth <= 0) throw new ValueError(`invalid width ${totalWidth} (must be > 0)`)
  const lines: string[] = []
  const pending = [...chunks].reverse()
  while (pending.length > 0) {
    const current: string[] = []
    let currentLength = 0
    const indent = lines.length > 0 ? subsequentIndent : initialIndent
    const width = totalWidth - codePointLength(indent)
    if (isBlank(pending[pending.length - 1] as string) && lines.length > 0) pending.pop()
    while (pending.length > 0) {
      const length = codePointLength(pending[pending.length - 1] as string)
      if (currentLength + length > width) break
      current.push(pending.pop() as string)
      currentLength += length
    }
    if (pending.length > 0 && codePointLength(pending[pending.length - 1] as string) > width) {
      splitLongWord(pending, current, currentLength, width)
      currentLength = current.reduce((total, chunk) => total + codePointLength(chunk), 0)
    }
    const last = current[current.length - 1]
    if (last !== undefined && isBlank(last)) current.pop()
    if (current.length > 0) lines.push(indent + current.join(""))
  }
  return lines
}

function splitLongWord(pending: string[], current: string[], currentLength: number, width: number): void {
  const spaceLeft = width < 1 ? 1 : width - currentLength
  if (spaceLeft > 0) {
    const characters = Array.from(pending[pending.length - 1] as string)
    let end = spaceLeft
    if (characters.length > spaceLeft) {
      const hyphen = characters.lastIndexOf("-", spaceLeft - 1)
      if (hyphen > 0 && characters.slice(0, hyphen).some((character) => character !== "-")) end = hyphen + 1
    }
    current.push(characters.slice(0, end).join(""))
    pending[pending.length - 1] = characters.slice(end).join("")
  } else if (current.length === 0) {
    current.push(pending.pop() as string)
  }
}

function isBlank(chunk: string): boolean {
  return pyStrip(chunk) === ""
}
