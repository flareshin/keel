import fs from "node:fs"

import { toOsError } from "./pyerrno.ts"
import { ValueError } from "./pyerrors.ts"

export class UnicodeDecodeError extends ValueError {}
export class UnicodeEncodeError extends ValueError {}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const STRICT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const LENIENT_DECODER = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })

export function decodeStrict(bytes: Uint8Array): string {
  try {
    return STRICT_DECODER.decode(bytes)
  } catch (error) {
    throw new UnicodeDecodeError(error instanceof Error ? error.message : String(error))
  }
}

export function decodeReplacing(bytes: Uint8Array): string {
  return LENIENT_DECODER.decode(bytes)
}

export function encodeStrict(text: string): Buffer {
  if (text.isWellFormed()) return Buffer.from(text, "utf8")
  throw new UnicodeEncodeError(describeFirstLoneSurrogateRun(text))
}

export function backslashReplaceLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, surrogateEscape)
}

function describeFirstLoneSurrogateRun(text: string): string {
  const codePoints = Array.from(text)
  const start = codePoints.findIndex(isLoneSurrogate)
  let end = start
  while (end < codePoints.length && isLoneSurrogate(codePoints[end] as string)) end++
  const subject =
    end - start === 1
      ? `character '${surrogateEscape(codePoints[start] as string)}' in position ${start}`
      : `characters in position ${start}-${end - 1}`
  return `'utf-8' codec can't encode ${subject}: surrogates not allowed`
}

function isLoneSurrogate(codePoint: string): boolean {
  return codePoint.length === 1 && codePoint >= "\ud800" && codePoint <= "\udfff"
}

function surrogateEscape(surrogate: string): string {
  return "\\u" + surrogate.charCodeAt(0).toString(16).padStart(4, "0")
}

export function readBytes(path: string): Buffer {
  try {
    return fs.readFileSync(path)
  } catch (error) {
    throw toOsError(error, path) ?? error
  }
}

export function readText(path: string): string {
  return translateNewlines(decodeStrict(readBytes(path)))
}

export function readTextUntranslated(path: string): string {
  return decodeStrict(readBytes(path))
}

export function translateNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

export function newlineSeparatedLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

export function countNewlines(bytes: Uint8Array): number {
  let count = 0
  for (const byte of bytes) if (byte === 0x0a) count++
  return count
}
