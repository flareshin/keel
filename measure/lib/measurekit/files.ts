import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const LINE_BREAK = /\r\n|\r|\n/

export class InvalidUtf8Error extends Error {}

export function readUtf8(file: string): string {
  const bytes = fs.readFileSync(file)
  try {
    return STRICT_UTF8.decode(bytes)
  } catch {
    throw new InvalidUtf8Error(`${file} is not valid UTF-8`)
  }
}

export function firstLine(file: string): string {
  const text = readUtf8(file)
  const end = text.indexOf("\n")
  return end < 0 ? text : text.slice(0, end)
}

export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).syscall !== undefined
}

export function isFile(file: string): boolean {
  return statOrNull(file)?.isFile() ?? false
}

export function isDir(file: string): boolean {
  return statOrNull(file)?.isDirectory() ?? false
}

export function isSymlink(file: string): boolean {
  return lstatOrNull(file)?.isSymbolicLink() ?? false
}

export function entryExists(file: string): boolean {
  return lstatOrNull(file) !== null
}

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function expandHome(file: string): string {
  if (file !== "~" && !file.startsWith("~/")) return file
  const home = os.homedir().replace(/\/+$/, "")
  return home + file.slice(1) || "/"
}

export function resolveLinks(file: string): string {
  const absolute = path.resolve(file)
  try {
    return fs.realpathSync(absolute)
  } catch (error) {
    if (!isSystemError(error)) throw error
    const parent = path.dirname(absolute)
    if (error.code === "ELOOP" || parent === absolute) return absolute
    return path.join(resolveLinks(parent), path.basename(absolute))
  }
}

export function walkEntries(top: string, skippedNames: ReadonlySet<string> = new Set()): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(top, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.filter((candidate) => !skippedNames.has(candidate.name))) {
    const entryPath = path.join(top, entry.name)
    found.push(entryPath)
    if (entry.isDirectory()) found.push(...walkEntries(entryPath, skippedNames))
  }
  return found.sort()
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch {
    return null
  }
}
