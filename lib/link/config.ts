import * as env from "../../measure/lib/measurekit/env.ts"
import { isDir, pyAbspath, realpath } from "../../measure/lib/measurekit/pypath.ts"
import { readTextUntranslated } from "../../measure/lib/measurekit/pyio.ts"
import { pythonJsonDumps } from "../../measure/lib/measurekit/pyjson.ts"
import type { PyValue } from "../../measure/lib/measurekit/pyvalue.ts"
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
  return { keelHome: realpath(env.keelHome()), overlayDir: realpath(env.overlayDir()), dataDir: pyAbspath(env.dataDir()) }
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

export function readText(path: string): string {
  return readTextUntranslated(path)
}

export function canonicalJson(value: PyValue | undefined): string {
  return pythonJsonDumps(value ?? null, { sortKeys: true, ensureAscii: false })
}
