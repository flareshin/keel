import path from "node:path"

import * as env from "../../measure/lib/measurekit/env.ts"
import { isDir, resolveLinks } from "../../measure/lib/measurekit/files.ts"
import { isExactInteger, isJsonObject, sortedKeys } from "../../measure/lib/measurekit/json.ts"
import type { JsonValue } from "../../measure/lib/measurekit/json.ts"
import { runProcess } from "../../measure/lib/measurekit/subprocess.ts"

export const EXIT_OK = 0
export const EXIT_NEGATIVE = 1
export const EXIT_REFUSED = 3
export const EXIT_INTERNAL = 70

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export class Refused extends Error {}

export interface KeelPaths {
  readonly keelHome: string
  readonly overlayDir: string
  readonly dataDir: string
}

export function resolvePaths(): KeelPaths {
  return { keelHome: resolveLinks(env.keelHome()), overlayDir: resolveLinks(env.overlayDir()), dataDir: path.resolve(env.dataDir()) }
}

export function expandPlaceholders(text: string, paths: KeelPaths, where: string): string {
  const values: Record<string, string> = { KEEL: paths.keelHome, OVERLAY: paths.overlayDir, DATA: paths.dataDir }
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Refused(`${where}: unknown placeholder {{${name}}}`)
    return values[name] as string
  })
}

export function runGit(cwd: string, ...args: string[]): string | null {
  if (!isDir(cwd)) return null
  const gitRun = runProcess(["git", "-C", cwd, ...args])
  return gitRun.returncode === 0 ? gitRun.stdout : null
}

export function canonicalJson(value: JsonValue | undefined): string {
  if (isExactInteger(value)) return value.rawJSON
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(", ")}]`
  if (isJsonObject(value)) {
    const members = sortedKeys(value).map((key) => `${JSON.stringify(key)}: ${canonicalJson(value[key])}`)
    return `{${members.join(", ")}}`
  }
  return JSON.stringify(value ?? null)
}
