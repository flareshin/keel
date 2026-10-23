import fs from "node:fs"
import path from "node:path"

import { isFile, isSymlink, readUtf8, resolveLinks, splitLines } from "../../measure/lib/measurekit/files.ts"
import { expandPlaceholders, Refused } from "./config.ts"
import type { KeelPaths } from "./config.ts"

export const MANIFEST_HEADER = ["source", "target"]
export const COPIED_TARGET_DIRS = ["scheduled-tasks"]

export interface LinkEntry {
  readonly source: string
  readonly target: string
}

export function readLinkManifest(paths: KeelPaths): LinkEntry[] {
  const entries: LinkEntry[] = []
  const declaredIn = new Map<string, string>()
  for (const manifest of [path.join(paths.keelHome, "settings", "links.tsv"), path.join(paths.overlayDir, "links.tsv")]) {
    for (const [source, target] of readTsv(manifest)) {
      const entry = buildEntry(source, target, manifest, paths)
      const declaredBefore = declaredIn.get(entry.target)
      if (declaredBefore !== undefined) throw new Refused(`${manifest}: target ${entry.target} is already declared in ${declaredBefore}`)
      declaredIn.set(entry.target, manifest)
      entries.push(entry)
    }
  }
  return entries
}

export function isCopied(entry: LinkEntry): boolean {
  return COPIED_TARGET_DIRS.includes(entry.target.split("/")[0] as string)
}

export function isKeelLink(link: string, paths: KeelPaths): boolean {
  if (!isSymlink(link)) return false
  const pointee = path.resolve(path.dirname(link), fs.readlinkSync(link))
  const roots = new Set([paths.keelHome, paths.overlayDir])
  for (const root of [...roots]) roots.add(resolveLinks(root))
  return [...roots].some((root) => pointee === root || pointee.startsWith(root + "/"))
}

function readTsv(manifest: string): [string, string][] {
  if (!isFile(manifest)) return []
  const lines = splitLines(readUtf8(manifest)).filter((line) => line.trim() !== "" && !line.startsWith("#"))
  const [header, ...body] = lines
  if (header !== undefined && !sameCells(header.split("\t"), MANIFEST_HEADER)) {
    throw new Refused(`${manifest}: header must be exactly ${MANIFEST_HEADER.join(" / ")}`)
  }
  return body.map((line) => {
    const cells = line.split("\t")
    const [source, target] = cells
    if (cells.length !== MANIFEST_HEADER.length || source === undefined || target === undefined) {
      throw new Refused(`${manifest}: expected ${MANIFEST_HEADER.length} tab-separated columns: ${JSON.stringify(line)}`)
    }
    return [source, target]
  })
}

function sameCells(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((cell, index) => cell === right[index])
}

function buildEntry(source: string, target: string, manifest: string, paths: KeelPaths): LinkEntry {
  const expanded = expandPlaceholders(source, paths, manifest)
  if (!expanded.startsWith("/")) throw new Refused(`${manifest}: source must be absolute after expansion: ${source}`)
  if (target.startsWith("/") || target.split("/").includes("..") || ["", "-", "."].includes(target)) {
    throw new Refused(`${manifest}: target must be a relative path inside KEEL_DATA_DIR without '..': ${target}`)
  }
  return { source: normalizedPath(expanded), target: normalizedPath(target) }
}

function normalizedPath(text: string): string {
  const normalized = path.normalize(text)
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "")
}
