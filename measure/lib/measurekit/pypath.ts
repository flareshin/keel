import fs from "node:fs"
import os from "node:os"

export function pyJoin(first: string, ...more: string[]): string {
  let result = first
  for (const part of more) {
    if (part.startsWith("/")) result = part
    else if (result === "" || result.endsWith("/")) result += part
    else result += "/" + part
  }
  return result
}

export function pyBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

export function pyDirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1)
  return head.replace(/\/+$/, "") || head
}

export function pySplitext(path: string): [string, string] {
  const base = pyBasename(path)
  const dot = base.lastIndexOf(".")
  const leadingDots = base.length - base.replace(/^\.+/, "").length
  if (dot < 0 || dot < leadingDots) return [path, ""]
  const stem = path.length - (base.length - dot)
  return [path.slice(0, stem), path.slice(stem)]
}

export function pyNormpath(path: string): string {
  if (path === "") return "."
  const leadingSlashes = path.startsWith("//") && !path.startsWith("///") ? 2 : path.startsWith("/") ? 1 : 0
  const kept: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    const canPop = kept.length > 0 && kept[kept.length - 1] !== ".."
    if (part !== ".." || (leadingSlashes === 0 && !canPop)) kept.push(part)
    else if (canPop) kept.pop()
  }
  return "/".repeat(leadingSlashes) + kept.join("/") || "."
}

export function pyAbspath(path: string): string {
  return pyNormpath(path.startsWith("/") ? path : pyJoin(process.cwd(), path))
}

export function pyRelpath(path: string, start: string = process.cwd()): string {
  const target = pyAbspath(path).split("/").filter(Boolean)
  const origin = pyAbspath(start).split("/").filter(Boolean)
  let shared = 0
  while (shared < Math.min(target.length, origin.length) && target[shared] === origin[shared]) shared++
  const parts = [...Array<string>(origin.length - shared).fill(".."), ...target.slice(shared)]
  return parts.join("/") || "."
}

export function expanduser(path: string): string {
  if (!path.startsWith("~")) return path
  const slash = path.indexOf("/")
  const user = slash < 0 ? path.slice(1) : path.slice(1, slash)
  if (user !== "") return path
  const home = (process.env["HOME"] ?? os.homedir()).replace(/\/+$/, "")
  return home + (slash < 0 ? "" : path.slice(slash)) || "/"
}

export function realpath(path: string): string {
  return pyAbspath(joinRealpath("", path, new Map()))
}

function joinRealpath(start: string, rest: string, seen: Map<string, string | null>): string {
  let current = start
  let remaining = rest
  if (remaining.startsWith("/")) {
    remaining = remaining.slice(1)
    current = "/"
  }
  while (remaining) {
    const slash = remaining.indexOf("/")
    const name = slash < 0 ? remaining : remaining.slice(0, slash)
    remaining = slash < 0 ? "" : remaining.slice(slash + 1)
    if (name === "" || name === ".") continue
    if (name === "..") {
      current = parentOf(current)
      continue
    }
    const candidate = pyJoin(current, name)
    if (!isSymlink(candidate)) {
      current = candidate
      continue
    }
    const known = seen.get(candidate)
    if (known !== undefined) {
      if (known !== null) {
        current = known
        continue
      }
      return pyJoin(candidate, remaining)
    }
    seen.set(candidate, null)
    current = joinRealpath(current, fs.readlinkSync(candidate), seen)
    seen.set(candidate, current)
  }
  return current
}

function parentOf(path: string): string {
  if (path === "") return ".."
  const head = pyDirname(path)
  const tail = pyBasename(path)
  return tail === ".." ? pyJoin(path, "..") : head
}

function isSymlink(path: string): boolean {
  try {
    return fs.lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export function pathExists(path: string): boolean {
  return fs.existsSync(path)
}

export function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDir(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isLink(path: string): boolean {
  return isSymlink(path)
}

export function isExecutable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface WalkEntry {
  current: string
  dirNames: string[]
  fileNames: string[]
}

export function* walk(top: string, skippedDirNames: ReadonlySet<string> = new Set()): Generator<WalkEntry> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(top, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))
  } catch {
    return
  }
  const dirNames: string[] = []
  const fileNames: string[] = []
  for (const entry of entries) {
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && isDir(pyJoin(top, entry.name)))
    ;(isDirectory ? dirNames : fileNames).push(entry.name)
  }
  yield { current: top, dirNames, fileNames }
  for (const name of dirNames) {
    const path = pyJoin(top, name)
    if (!skippedDirNames.has(name) && !isSymlink(path)) yield* walk(path, skippedDirNames)
  }
}

export function which(command: string): string | null {
  const candidates = command.includes("/") ? [command] : (process.env["PATH"] ?? "").split(":").map((directory) => pyJoin(directory || ".", command))
  return candidates.find((candidate) => isExecutable(candidate) && !isDir(candidate)) ?? null
}
