import path from "node:path"

import { FINDINGS_LOG } from "../../../lib/evidence/findings.ts"
import { readJsonl } from "./datafiles.ts"
import * as env from "./env.ts"
import { InvalidUtf8Error, isSystemError } from "./files.ts"
import { compareCodePoints } from "./json.ts"
import type { JsonObject } from "./json.ts"

const RECURRING_ROOTS = 2
const TOP_RECURRING = 20
const NO_PATH = /^N\/A\b/

export interface RecurringKey {
  repo: string
  path: string
  lens: string
  roots: number
}

export interface RecurringFindings {
  findings: number
  keys: number
  recurring_keys: number
  top_recurring: RecurringKey[]
  unkeyed: number
  unparsed: number
  malformed: number
}

interface KeyedFinding {
  repo: string
  path: string
  lens: string
  rootRunId: string
}

export function summarizeRecurringFindings(): RecurringFindings | { error: string } {
  let log: { records: JsonObject[]; malformed: number }
  try {
    log = readJsonl(path.join(env.logsDir(), FINDINGS_LOG))
  } catch (error) {
    if (!(error instanceof InvalidUtf8Error || isSystemError(error))) throw error
    return { error: `unreadable ${FINDINGS_LOG}: ${error.message}` }
  }
  const unparsed = log.records.filter((record) => record["unparsed"] === true)
  const findings = log.records.filter((record) => record["unparsed"] !== true)
  const keyed = findings.map(keyedFinding).filter((finding) => finding !== null)
  const recurring = recurringKeys(keyed)
  return {
    findings: findings.length,
    keys: new Set(keyed.map(keyOf)).size,
    recurring_keys: recurring.length,
    top_recurring: recurring.slice(0, TOP_RECURRING),
    unkeyed: findings.length - keyed.length,
    unparsed: unparsed.length,
    malformed: log.malformed,
  }
}

function keyedFinding(record: JsonObject): KeyedFinding | null {
  const { repo, path: findingPath, lens, root_run_id: rootRunId } = record
  if (typeof repo !== "string" || typeof lens !== "string" || typeof rootRunId !== "string") return null
  if (typeof findingPath !== "string" || findingPath === "" || NO_PATH.test(findingPath)) return null
  return { repo, path: findingPath, lens, rootRunId }
}

function keyOf(finding: KeyedFinding): string {
  return JSON.stringify([finding.repo, finding.path, finding.lens])
}

function recurringKeys(keyed: KeyedFinding[]): RecurringKey[] {
  const rootsByKey = new Map<string, Set<string>>()
  for (const finding of keyed) {
    const roots = rootsByKey.get(keyOf(finding)) ?? new Set<string>()
    roots.add(finding.rootRunId)
    rootsByKey.set(keyOf(finding), roots)
  }
  return [...rootsByKey].filter(([, roots]) => roots.size >= RECURRING_ROOTS)
    .map(([key, roots]): RecurringKey => {
      const [repo, findingPath, lens] = JSON.parse(key) as [string, string, string]
      return { repo, path: findingPath, lens, roots: roots.size }
    })
    .sort((left, right) => right.roots - left.roots || compareCodePoints(left.repo, right.repo)
      || compareCodePoints(left.path, right.path) || compareCodePoints(left.lens, right.lens))
}
