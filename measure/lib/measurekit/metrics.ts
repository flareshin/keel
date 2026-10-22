import * as env from "./env.ts"
import { readJsonl } from "./datafiles.ts"
import { gitSucceeds } from "./gitutil.ts"
import { EMPTY } from "./ledger.ts"
import type { LedgerRow } from "./ledger.ts"
import { isOsError, ValueError } from "./pyerrors.ts"
import { pythonJsonLoads } from "./pyjson.ts"
import { expanduser, isExecutable, isFile, pyJoin } from "./pypath.ts"
import { firstCodePoints, pyStrip } from "./pystr.ts"
import { isJsonObject, isPyInt, pyRepr, pyStr } from "./pyvalue.ts"
import type { JsonObject, PyValue } from "./pyvalue.ts"
import { runProcess, TimeoutExpired } from "./subprocess.ts"
import type { RunResult } from "./subprocess.ts"

export const PASS = "PASS"
export const FAIL = "FAIL"
export const GRACE = "GRACE"
export const WARN = "WARN"
export const DEFAULT_WINDOW_DAYS = 60
const RUNNER_TIMEOUT_SECONDS = 120
const STDERR_EXCERPT_CHARS = 200
const NON_DECISION_OUTCOMES = new Set(["error", "contract-miss"])

export class MetricError extends Error {}

export interface MetricResult {
  id: string
  metric: string
  count: number
  items: PyValue[]
  status: string
  error?: string
}

export type MetricItems = [number, PyValue[]]

export function evaluateMetric(row: LedgerRow, since: string, today: string): MetricResult {
  try {
    const [count, items] = collectMetricItems(row.metric, since)
    const status = count > 0 ? PASS : row.isInGrace(today) ? GRACE : FAIL
    return { id: row.id, metric: row.metric, count, items, status }
  } catch (error) {
    if (!(error instanceof MetricError)) throw error
    return { id: row.id, metric: row.metric, count: 0, items: [], status: FAIL, error: error.message }
  }
}

export function collectMetricItems(metric: string, since: string): MetricItems {
  if (metric === EMPTY) throw new MetricError("row has no metric")
  const colon = metric.indexOf(":")
  const kind = colon < 0 ? metric : metric.slice(0, colon)
  const argument = colon < 0 ? "" : metric.slice(colon + 1)
  switch (kind) {
    case "fires": return firesItems(argument, since)
    case "evals": return evalItems(argument, since)
    case "run": return runnerItems(argument, since)
    case "exists": return existenceItems(argument)
    default: throw new MetricError(`unknown metric kind ${pyRepr(kind)}`)
  }
}

function firesItems(ruleId: string, since: string): MetricItems {
  const { records } = readJsonl(pyJoin(env.logsDir(), "keel-fires.jsonl"))
  const items = records.filter(
    (record) => record["rule_id"] === ruleId && !NON_DECISION_OUTCOMES.has(record["outcome"] as string) && isWithinWindow(record, since),
  )
  return [items.length, items]
}

function evalItems(evalId: string, since: string): MetricItems {
  const { records } = readJsonl(pyJoin(env.logsDir(), "keel-evals.jsonl"))
  const items = records.filter((record) => record["eval_id"] === evalId && record["pass"] === true && isWithinWindow(record, since))
  return [items.length, items]
}

function isWithinWindow(record: JsonObject, since: string): boolean {
  const timestamp = "ts" in record ? pyStr(record["ts"]) : ""
  return firstCodePoints(timestamp, 10) >= since
}

function runnerItems(runner: string, since: string): MetricItems {
  const path = findRunner(runner)
  if (path === null) throw new MetricError(`no runner measure/metrics/${runner} in keel or overlay`)
  let completed: RunResult
  try {
    completed = runProcess([path, "--since", since], { timeoutSeconds: RUNNER_TIMEOUT_SECONDS })
  } catch (error) {
    if (error instanceof TimeoutExpired || isOsError(error)) throw new MetricError(`runner ${runner} could not run: ${(error as Error).message}`)
    throw error
  }
  if (completed.returncode !== 0) throw new MetricError(`runner ${runner} exited ${completed.returncode}: ${stderrExcerpt(completed)}`)
  let payload: PyValue
  try {
    payload = pythonJsonLoads(completed.stdout)
  } catch (error) {
    if (error instanceof ValueError) throw new MetricError(`runner ${runner} did not print one JSON object`)
    throw error
  }
  const count = isJsonObject(payload) ? payload["count"] : undefined
  const items = isJsonObject(payload) ? payload["items"] : undefined
  if (!isPyInt(count) || !Array.isArray(items)) throw new MetricError(`runner ${runner} must print {"count": int, "items": [...]}`)
  return [Number(count), items]
}

export function findRunner(runner: string): string | null {
  const candidates = [env.keelHome(), env.overlayDir()].map((root) => pyJoin(root, "measure", "metrics", runner))
  return candidates.find((path) => isFile(path) && isExecutable(path)) ?? null
}

function existenceItems(argument: string): MetricItems {
  const parts = splitAtMost(argument, ":", 2)
  if (parts.length !== 3) throw new MetricError("exists metric needs <repo path>:<ref>:<path>")
  const [repo, ref, path] = parts as [string, string, string]
  const objectName = `${ref}:${path}`
  if (!gitSucceeds(expanduser(repo), ["cat-file", "-e", objectName])) return [0, []]
  return [1, [objectName]]
}

function splitAtMost(text: string, separator: string, maxSplits: number): string[] {
  const parts: string[] = []
  let rest = text
  while (parts.length < maxSplits) {
    const index = rest.indexOf(separator)
    if (index < 0) break
    parts.push(rest.slice(0, index))
    rest = rest.slice(index + separator.length)
  }
  parts.push(rest)
  return parts
}

export function stderrExcerpt(completed: RunResult): string {
  return firstCodePoints(pyStrip(completed.stderr), STDERR_EXCERPT_CHARS)
}
