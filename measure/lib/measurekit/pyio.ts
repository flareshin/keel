import fs from "node:fs"

import { OsError, ValueError } from "./pyerrors.ts"
import { pyRepr } from "./pyvalue.ts"

export class UnicodeDecodeError extends ValueError {}

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

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "[Errno 2] No such file or directory",
  EACCES: "[Errno 13] Permission denied",
  ENOTDIR: "[Errno 20] Not a directory",
  EISDIR: "[Errno 21] Is a directory",
}

export function readBytes(path: string): Buffer {
  try {
    return fs.readFileSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ""
    const text = ERRNO_TEXT[code]
    if (text === undefined) throw error
    throw new OsError(`${text}: ${pyRepr(path)}`)
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

export function textLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

export function countNewlines(bytes: Uint8Array): number {
  let count = 0
  for (const byte of bytes) if (byte === 0x0a) count++
  return count
}
