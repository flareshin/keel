const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"])
const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null/y

export function skipWhitespace(text: string, index: number): number {
  let end = index
  while (JSON_WHITESPACE.has(text.charAt(end))) end++
  return end
}

export function valueEnd(text: string, start: number): number {
  const first = text.charAt(start)
  if (first === '"') return stringEnd(text, start)
  if (first === "{" || first === "[") return containerEnd(text, start)
  SCALAR.lastIndex = start
  if (SCALAR.exec(text) === null) throw new SyntaxError(`no JSON value at position ${start}`)
  return SCALAR.lastIndex
}

function containerEnd(text: string, start: number): number {
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '"') {
      index = stringEnd(text, index)
      continue
    }
    if (char === "{" || char === "[") depth++
    else if ((char === "}" || char === "]") && --depth === 0) return index + 1
    index++
  }
  throw new SyntaxError(`unterminated JSON container at position ${start}`)
}

function stringEnd(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === "\\") index += 2
    else if (char === '"') return index + 1
    else index++
  }
  throw new SyntaxError(`unterminated JSON string at position ${start}`)
}
