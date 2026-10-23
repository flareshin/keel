export class ShlexError extends Error {}

const WHITESPACE = new Set([" ", "\t", "\r", "\n"])
const QUOTES = new Set(["'", '"'])
const ESCAPE = "\\"
const ESCAPED_QUOTES = '"'

type State = "start" | "word" | "escape" | string

export function shlexSplit(text: string): string[] {
  const tokens: string[] = []
  let state: State = "start"
  let escapedState: State = "word"
  let token = ""
  let quoted = false
  for (const char of text) {
    if (state === "start" || state === "word") {
      if (WHITESPACE.has(char)) {
        if (token !== "" || quoted) tokens.push(token)
        token = ""
        quoted = false
        state = "start"
      } else if (char === ESCAPE) {
        escapedState = "word"
        state = "escape"
      } else if (QUOTES.has(char)) {
        state = char
      } else {
        token += char
        state = "word"
      }
    } else if (state === "escape") {
      if (escapedState === ESCAPED_QUOTES && char !== ESCAPED_QUOTES && char !== ESCAPE) token += ESCAPE
      token += char
      state = escapedState
    } else if (char === state) {
      quoted = true
      state = "word"
    } else if (state === ESCAPED_QUOTES && char === ESCAPE) {
      escapedState = state
      state = "escape"
    } else {
      token += char
    }
  }
  if (state === "escape") throw new ShlexError("No escaped character")
  if (QUOTES.has(state)) throw new ShlexError("No closing quotation")
  if (token !== "" || quoted) tokens.push(token)
  return tokens
}

const UNSAFE_CHARACTER = /[^A-Za-z0-9_@%+=:,./-]/

export function shlexQuote(text: string): string {
  if (text === "") return "''"
  if (!UNSAFE_CHARACTER.test(text)) return text
  return "'" + text.replaceAll("'", "'\"'\"'") + "'"
}
