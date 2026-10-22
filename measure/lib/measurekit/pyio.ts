import fs from "node:fs"

import { toOsError } from "./pyerrno.ts"
import { ValueError } from "./pyerrors.ts"

export class UnicodeDecodeError extends ValueError {}
export class UnicodeEncodeError extends ValueError {}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const STRICT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const LENIENT_DECODER = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })

const INVALID_START_BYTE = "invalid start byte"
const INVALID_CONTINUATION_BYTE = "invalid continuation byte"
const UNEXPECTED_END_OF_DATA = "unexpected end of data"
const READ_CHUNK_BYTES = 8192
const LINE_END = /[\r\n]/

interface Utf8Fault {
  readonly start: number
  readonly end: number
  readonly reason: string
}

interface Utf8Scan {
  readonly fault: Utf8Fault | null
  readonly incompleteTail: number
}

export function decodeStrict(bytes: Uint8Array): string {
  try {
    return STRICT_DECODER.decode(bytes)
  } catch {
    throw new UnicodeDecodeError(describeUtf8Fault(bytes, scanUtf8(bytes, true).fault))
  }
}

export function firstLineOf(bytes: Uint8Array): string {
  let decoded = ""
  for (const piece of decodeChunks(bytes)) {
    decoded += piece
    if (LINE_END.test(piece)) break
  }
  return cutAtFirstLineEnd(decoded)
}

export function readTextByLines(path: string): string {
  return translateNewlines(Array.from(decodeChunks(readBytes(path))).join(""))
}

function* decodeChunks(bytes: Uint8Array): Generator<string> {
  let undecoded: Uint8Array = new Uint8Array(0)
  let heldCarriageReturn = false
  for (let offset = 0; ; offset += READ_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + READ_CHUNK_BYTES)
    const isLast = chunk.length === 0
    const pending = Buffer.concat([undecoded, chunk])
    const scan = scanUtf8(pending, isLast)
    if (scan.fault !== null) throw new UnicodeDecodeError(describeUtf8Fault(pending, scan.fault))
    const decodedEnd = pending.length - scan.incompleteTail
    undecoded = pending.subarray(decodedEnd)
    let piece = LENIENT_DECODER.decode(pending.subarray(0, decodedEnd))
    if (heldCarriageReturn && (isLast || piece !== "")) {
      piece = "\r" + piece
      heldCarriageReturn = false
    }
    if (!isLast && piece.endsWith("\r")) {
      piece = piece.slice(0, -1)
      heldCarriageReturn = true
    }
    yield piece
    if (isLast) return
  }
}

function cutAtFirstLineEnd(text: string): string {
  const lineEnd = text.search(LINE_END)
  if (lineEnd < 0) return text
  const crlf = text.startsWith("\r\n", lineEnd)
  return text.slice(0, lineEnd + (crlf ? 2 : 1))
}

function scanUtf8(bytes: Uint8Array, isFinal: boolean): Utf8Scan {
  const end = bytes.length
  let start = 0
  while (start < end) {
    const lead = bytes[start] as number
    if (lead < 0x80) {
      start++
      continue
    }
    if (lead < 0xc2 || lead > 0xf4) return rejected(start, start + 1, INVALID_START_BYTE)
    const length = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
    for (let index = 1; index < length; index++) {
      if (start + index >= end) {
        if (isFinal) return rejected(start, end, UNEXPECTED_END_OF_DATA)
        return { fault: null, incompleteTail: end - start }
      }
      const next = bytes[start + index] as number
      if (isContinuationAt(lead, index, next)) continue
      if (!isFinal && isSurrogatePrefixEndingTheData(lead, next, start + index + 1 === end)) return { fault: null, incompleteTail: end - start }
      return rejected(start, start + index, INVALID_CONTINUATION_BYTE)
    }
    start += length
  }
  return { fault: null, incompleteTail: 0 }
}

function isSurrogatePrefixEndingTheData(lead: number, second: number, endsTheData: boolean): boolean {
  return endsTheData && lead === 0xed && second >= 0xa0 && second <= 0xbf
}

function isContinuationAt(lead: number, index: number, byte: number): boolean {
  if (byte < 0x80 || byte > 0xbf) return false
  if (index > 1) return true
  if (lead === 0xe0) return byte >= 0xa0
  if (lead === 0xed) return byte < 0xa0
  if (lead === 0xf0) return byte >= 0x90
  if (lead === 0xf4) return byte < 0x90
  return true
}

function rejected(start: number, end: number, reason: string): Utf8Scan {
  return { fault: { start, end, reason }, incompleteTail: 0 }
}

function describeUtf8Fault(bytes: Uint8Array, fault: Utf8Fault | null): string {
  if (fault === null) return "'utf-8' codec can't decode bytes: invalid data"
  if (fault.end === fault.start + 1) {
    const hex = (bytes[fault.start] as number).toString(16).padStart(2, "0")
    return `'utf-8' codec can't decode byte 0x${hex} in position ${fault.start}: ${fault.reason}`
  }
  return `'utf-8' codec can't decode bytes in position ${fault.start}-${fault.end - 1}: ${fault.reason}`
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
