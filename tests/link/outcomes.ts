import fs from "node:fs"
import path from "node:path"

const DETAILED_STDERR_KINDS = new Set(["link: adopt drops", "link: forced"])
const STDERR_KIND = /^(usage|link: [a-z][a-z0-9 ,-]*?)(?::|$)/
const COLOUR_CODE = /\x1b\[[0-9;]*m/g

export interface CommandRecord {
  args: string[]
  status: number | null
  stdout: string
  stderr: string
}

export interface CommandSummary {
  args: string[]
  status: number | null
  stdout: unknown
  stderr: string[]
}

export interface TreeEntry {
  path: string
  type: string
  mode: number
  target?: string
  bytes?: string
}

export function summarizeCommand(command: CommandRecord): CommandSummary {
  return { args: command.args, status: command.status, stdout: summarizeStdout(command.stdout), stderr: summarizeStderr(command.stderr) }
}

export function summarizeStdout(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (trimmed === "") return ""
  try {
    return JSON.parse(trimmed)
  } catch {
    return "text"
  }
}

export function summarizeStderr(stderr: string): string[] {
  const kinds: string[] = []
  for (const line of stderr.replace(COLOUR_CODE, "").split("\n")) {
    const kind = STDERR_KIND.exec(line)?.[1]
    if (kind !== undefined) kinds.push(DETAILED_STDERR_KINDS.has(kind) ? line : kind)
  }
  return kinds
}

export function summarizeTree(tree: unknown): unknown {
  if (!Array.isArray(tree)) return tree
  return (tree as TreeEntry[]).map((entry) => (entry.bytes === undefined ? entry : { ...entry, bytes: fileContent(entry.path, entry.bytes) }))
}

function fileContent(file: string, latin1Bytes: string): unknown {
  const text = Buffer.from(latin1Bytes, "latin1").toString("utf8")
  if (!file.endsWith(".json")) return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "..", "fixtures", "link")
const ROOT_TOKEN = "{{ROOT}}"

export function readFixtureOutcomes(name: string, root: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), "utf8")
  return JSON.parse(text.replaceAll(ROOT_TOKEN, JSON.stringify(root).slice(1, -1))) as Record<string, unknown>
}
