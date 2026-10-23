import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs"
import { basename, join, relative } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

const CHECKOUT = realpathSync(join(import.meta.dirname, ".."))
const CHECKOUT_TOKEN = "{{KEEL_HOME}}"

export const ROOT_TOKEN = "{{ROOT}}"
const ENV_TOKEN_PATTERN = /\{\{ENV:([^}]+)\}\}/g
const SKIPPED_SUFFIX = ".sample"
const BLOB_ID_LENGTH = 16
const TREE_ID_LENGTH = 12

export type TreeEntry = [path: string, kind: "d" | "f" | "l", mode: number, reference: string]

export interface SnapshotStore {
  blobs: Record<string, string>
  trees: Record<string, TreeEntry[]>
}

export interface ObservedDelta {
  code: number | null
  stdout: string
  stderr: string
  set: Record<string, string>
  removed: string[]
}

const MIN_RANDOM_CHARACTERS = 8
const ROOT_STEM = "keel-parity-"

const NON_ASCII = /[^\x00-\x7f]/g

export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(NON_ASCII, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

export function digestOf(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

const SLUG_TOKEN = "{{ROOT-SLUG}}"
const NAME_TOKEN = "{{ROOT-NAME}}"
const UPPER_TOKEN = "{{ROOT-UPPER}}"
const LOWER_TOKEN = "{{ROOT-LOWER}}"

function slugOf(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, "-")
}

export function tokenized(text: string, root: string): string {
  return text.replaceAll(root, ROOT_TOKEN).replaceAll(root.toUpperCase(), UPPER_TOKEN).replaceAll(root.toLowerCase(), LOWER_TOKEN)
    .replaceAll(slugOf(root), SLUG_TOKEN).replaceAll(basename(root), NAME_TOKEN).replaceAll(CHECKOUT, CHECKOUT_TOKEN)
}

export function restored(text: string, root: string): string {
  return text.replaceAll(ROOT_TOKEN, root).replaceAll(UPPER_TOKEN, root.toUpperCase()).replaceAll(LOWER_TOKEN, root.toLowerCase())
    .replaceAll(SLUG_TOKEN, slugOf(root)).replaceAll(NAME_TOKEN, basename(root)).replaceAll(CHECKOUT_TOKEN, CHECKOUT)
}

export class SnapshotPacker {
  readonly store: SnapshotStore = { blobs: {}, trees: {} }
  addTree(directory: string, root: string): string {
    const entries: TreeEntry[] = []
    this.walk(directory, directory, root, entries)
    const identifier = digestOf(JSON.stringify(entries)).slice(0, TREE_ID_LENGTH)
    this.store.trees[identifier] = entries
    return identifier
  }

  private walk(base: string, directory: string, root: string, entries: TreeEntry[]): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const key = tokenized(relative(base, path), root)
      const status = lstatSync(path)
      const mode = status.mode & 0o7777
      if (status.isSymbolicLink()) entries.push([key, "l", mode, tokenized(readlinkSync(path), root)])
      else if (status.isDirectory()) {
        entries.push([key, "d", mode, ""])
        this.walk(base, path, root, entries)
      } else if (!name.endsWith(SKIPPED_SUFFIX)) entries.push([key, "f", mode, this.addBlob(readableBytes(path), root)])
    }
  }

  private addBlob(content: Buffer, root: string): string {
    const text = textOf(content)
    const encoded = text === null ? `b${content.toString("base64")}` : `t${tokenized(text, root)}`
    const identifier = digestOf(encoded).slice(0, BLOB_ID_LENGTH)
    this.store.blobs[identifier] = encoded
    return identifier
  }
}

function readableBytes(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error
    return Buffer.alloc(0)
  }
}

function textOf(content: Buffer): string | null {
  const text = content.toString("utf8")
  return Buffer.from(text, "utf8").equals(content) && !text.includes("\0") ? text : null
}

export function materialize(store: SnapshotStore, identifier: string, destination: string): void {
  const entries = store.trees[identifier]
  if (entries === undefined) throw new Error(`no recorded snapshot ${identifier}`)
  mkdirSync(destination, { recursive: true })
  const directories: Array<[string, number]> = []
  for (const [key, kind, mode, reference] of entries) {
    const path = join(destination, restored(key, destination))
    if (kind === "d") {
      mkdirSync(path, { recursive: true })
      directories.push([path, mode])
    } else if (kind === "l") symlinkSync(restored(reference, destination), path)
    else {
      writeFileSync(path, blobContent(store, reference, destination))
      chmodSync(path, mode)
    }
  }
  for (const [path, mode] of directories.reverse()) chmodSync(path, mode)
}

function blobContent(store: SnapshotStore, reference: string, destination: string): Buffer {
  const encoded = store.blobs[reference]
  if (encoded === undefined) throw new Error(`no recorded blob ${reference}`)
  const body = encoded.slice(1)
  return encoded.startsWith("b") ? Buffer.from(body, "base64") : Buffer.from(restored(body, destination), "utf8")
}

const SANDBOX_ENV_PREFIXES = ["KEEL_", "GIT_"]
const SHELL_MANAGED_NAMES = new Set(["PWD", "OLDPWD", "SHLVL", "_"])

export function envTemplate(env: Record<string, string>, inherited: NodeJS.ProcessEnv, root: string): Record<string, string> {
  const overridden = Object.entries(env).filter(([name, value]) => inherited[name] !== value && !SHELL_MANAGED_NAMES.has(name))
  return Object.fromEntries(overridden.map(([name, value]) => {
    const own = inherited[name]
    const rooted = tokenized(value, root)
    return [name, own === undefined || own === "" ? rooted : rooted.replaceAll(own, `{{ENV:${name}}}`)]
  }))
}

export function envFromTemplate(template: Record<string, string>, root: string): Record<string, string> {
  const inherited = Object.entries(process.env).flatMap(([name, value]): Array<[string, string]> => (
    value === undefined || SANDBOX_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ? [] : [[name, value]]
  ))
  const overrides = Object.entries(template).map(([name, value]): [string, string] => [
    name, restored(value, root).replace(ENV_TOKEN_PATTERN, (_whole, variable: string) => process.env[variable] ?? ""),
  ])
  return Object.fromEntries([...inherited, ...overrides])
}

export function deltaBetween(before: Map<string, string>, after: Map<string, string>): Pick<ObservedDelta, "set" | "removed"> {
  const set: Record<string, string> = {}
  for (const [key, content] of after) if (before.get(key) !== content) set[key] = content
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort()
  return { set, removed }
}

export function paddedRoot(parent: string, length: number): string {
  const stem = join(parent, ROOT_STEM)
  const free = length - stem.length
  if (free < MIN_RANDOM_CHARACTERS) throw new Error(`${parent} is too long: the recorded paths need a root of ${length} characters`)
  return stem + randomBytes(free).toString("hex").slice(0, free)
}

export interface Observation {
  code: number | null
  stdout: string
  stderr: string
  files: Map<string, string>
}

export interface Run {
  observation: Observation
  initial: Map<string, string>
}

export interface Execution {
  command: string[]
  stdin: string
  env: Record<string, string>
  cwd: string
  timeoutMs: number
}

const OUTPUT_LIMIT_BYTES = 1 << 28
const EXCERPT_CHARACTERS = Number(process.env["KEEL_PARITY_EXCERPT"] ?? 240)

export function runInSandbox(root: string, prepare: (root: string) => void, execution: Execution, readTree: (root: string) => Map<string, string>): Run {
  rmSync(root, { recursive: true, force: true })
  prepare(root)
  const initial = readTree(root)
  const completed = spawnSync(execution.command[0] as string, execution.command.slice(1), {
    input: execution.stdin, encoding: "utf8", env: execution.env, cwd: execution.cwd, timeout: execution.timeoutMs, maxBuffer: OUTPUT_LIMIT_BYTES,
  })
  const observation = { code: completed.status, stdout: completed.stdout, stderr: completed.stderr, files: readTree(root) }
  rmSync(root, { recursive: true, force: true })
  return { observation, initial }
}

export function deltaOf(root: string, run: Run): ObservedDelta {
  const { observation, initial } = run
  return {
    code: observation.code, stdout: tokenized(observation.stdout, root), stderr: tokenized(observation.stderr, root),
    ...tokenizedDelta(deltaBetween(initial, observation.files), root),
  }
}

function tokenizedDelta(delta: Pick<ObservedDelta, "set" | "removed">, root: string): Pick<ObservedDelta, "set" | "removed"> {
  return {
    set: Object.fromEntries(Object.entries(delta.set).map(([key, content]) => [tokenized(key, root), tokenized(content, root)])),
    removed: delta.removed.map((key) => tokenized(key, root)),
  }
}

export function excerpt(value: unknown): string {
  if (value === undefined) return "<absent>"
  const text = JSON.stringify(value) ?? String(value)
  return text.length > EXCERPT_CHARACTERS ? text.slice(0, EXCERPT_CHARACTERS) + "…" : text
}

export function differencesFromRecorded(expected: ObservedDelta, run: Run, root: string): string[] {
  const actual = deltaOf(root, run)
  const differences: string[] = []
  for (const field of ["code", "stdout", "stderr"] as const) {
    if (expected[field] !== actual[field]) differences.push(`${field}: python ${excerpt(expected[field])} / node ${excerpt(actual[field])}`)
  }
  for (const key of new Set([...Object.keys(expected.set), ...Object.keys(actual.set)])) {
    if (expected.set[key] !== actual.set[key]) differences.push(`file ${key}: python ${excerpt(expected.set[key])} / node ${excerpt(actual.set[key])}`)
  }
  const removedExpected = new Set(expected.removed)
  const removedActual = new Set(actual.removed)
  for (const key of new Set([...removedExpected, ...removedActual])) {
    if (removedExpected.has(key) !== removedActual.has(key)) {
      differences.push(`file ${key}: python ${removedExpected.has(key) ? "removed" : "kept"} / node ${removedActual.has(key) ? "removed" : "kept"}`)
    }
  }
  return differences
}

export function readFixtureFile(directory: string, name: string): string {
  try {
    return readFileSync(join(directory, name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return gunzipSync(readFileSync(join(directory, `${name}.gz`))).toString("utf8")
  }
}

export function writeFixtureFile(directory: string, name: string, text: string, compress: boolean): void {
  rmSync(join(directory, name), { force: true })
  rmSync(join(directory, `${name}.gz`), { force: true })
  if (compress) writeFileSync(join(directory, `${name}.gz`), gzipSync(text, { level: 9 }))
  else writeFileSync(join(directory, name), text)
}
