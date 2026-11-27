import fs from "node:fs"
import path from "node:path"

import * as env from "./env.ts"
import { readJsonl } from "./datafiles.ts"
import { gitSucceeds } from "./gitutil.ts"
import { EMPTY } from "./ledger.ts"
import type { LedgerRow } from "./ledger.ts"
import { expandHome, isDir, isExecutable, isFile, isSystemError } from "./files.ts"
import { FIRES_LOG, isSyntheticSession, PROCEDURAL_KIND } from "./fireslog.ts"
import { isJsonObject, parseJson } from "./json.ts"
import type { JsonObject, JsonValue } from "./json.ts"
import { runProcess, runProcessAsync } from "./subprocess.ts"
import { TimeoutExpired } from "./timeout.ts"
import type { RunResult } from "./subprocess.ts"

export const PASS = "PASS"
export const FAIL = "FAIL"
export const GRACE = "GRACE"
export const WARN = "WARN"
export const DEFAULT_WINDOW_DAYS = 60
const RUNNER_TIMEOUT_SECONDS = 120
const DEFECT_RUNNER_PREFIX = "defects-"
const RESULT_KEYS = new Set(["count", "items", "id", "metric", "status", "error"])
export const MAX_CONCURRENT_RUNNERS = 6
const ISO_DATE_LENGTH = 10
const STDERR_EXCERPT_CHARS = 200
const NON_DECISION_OUTCOMES = new Set(["error", "contract-miss", "warn"])

export class MetricError extends Error {}

export interface MetricResult {
  id: string
  metric: string
  count: number
  items: JsonValue[]
  status: string
  error?: string
}

export type MetricItems = [count: number, items: JsonValue[], extraKeys?: JsonObject]

export type FinishedRunners = ReadonlyMap<string, RunResult | MetricError>

export function evaluateMetric(row: LedgerRow, since: string, today: string, finished: FinishedRunners = new Map()): MetricResult {
  try {
    const [count, items, extraKeys] = collectMetricItems(row.metric, since, finished)
    const status = count > 0 ? PASS : row.isInGrace(today) ? GRACE : FAIL
    return { ...extraKeys, id: row.id, metric: row.metric, count, items, status }
  } catch (error) {
    if (!(error instanceof MetricError)) throw error
    return { id: row.id, metric: row.metric, count: 0, items: [], status: FAIL, error: error.message }
  }
}

function splitMetric(metric: string): [kind: string, argument: string] {
  const colon = metric.indexOf(":")
  return colon < 0 ? [metric, ""] : [metric.slice(0, colon), metric.slice(colon + 1)]
}

export function collectMetricItems(metric: string, since: string, finished: FinishedRunners = new Map()): MetricItems {
  if (metric === EMPTY) throw new MetricError("row has no metric")
  const [kind, argument] = splitMetric(metric)
  switch (kind) {
    case "fires": return firesItems(argument, since)
    case "evals": return evalItems(argument, since)
    case "run": return runnerItems(argument, since, finished)
    case "exists": return existenceItems(argument)
    default: throw new MetricError(`unknown metric kind ${JSON.stringify(kind)}`)
  }
}

function firesItems(ruleId: string, since: string): MetricItems {
  const { records } = readJsonl(path.join(env.logsDir(), FIRES_LOG))
  const items = records.filter((record) => record["rule_id"] === ruleId && isCountedFire(record, since))
  return [items.length, items]
}

export function isCountedFire(record: JsonObject, since: string): boolean {
  return !NON_DECISION_OUTCOMES.has(record["outcome"] as string) && record["kind"] !== PROCEDURAL_KIND
    && !isSyntheticSession(record["session"]) && isWithinWindow(record, since)
}

function evalItems(evalId: string, since: string): MetricItems {
  const { records } = readJsonl(path.join(env.logsDir(), "keel-evals.jsonl"))
  const lines = records.filter((record) => record["eval_id"] === evalId)
  const inWindow = lines.filter((line) => isWithinWindow(line, since))
  const newest = inWindow.reduce<JsonObject | null>((latest, line) => latest === null || (line["ts"] as string) >= (latest["ts"] as string) ? line : latest, null)
  if (newest?.["pass"] !== true) return [0, []]
  return "regraded_from" in newest && !isRegradeOfLatestRun(newest, lines, since) ? [0, []] : [1, [newest]]
}

function isRegradeOfLatestRun(regrade: JsonObject, lines: JsonObject[], since: string): boolean {
  const runTs = regrade["run_ts"]
  if (typeof runTs !== "string" || !isOnOrAfter(runTs, since)) return false
  return !lines.some((line) => {
    const runTime = line["run_ts"] ?? line["ts"]
    return typeof runTime === "string" && runTime > runTs
  })
}

export function isWithinWindow(record: JsonObject, since: string): boolean {
  return isOnOrAfter(record["ts"], since)
}

function isOnOrAfter(timestamp: JsonValue | undefined, since: string): boolean {
  return typeof timestamp === "string" && timestamp.slice(0, ISO_DATE_LENGTH) >= since
}

function runnerItems(runner: string, since: string, finished: FinishedRunners): MetricItems {
  const path = findRunner(runner)
  if (path === null) throw new MetricError(`no runner measure/metrics/${runner} in keel or overlay`)
  const completed = finished.get(runner) ?? runRunnerBlocking(runner, path, since)
  if (completed instanceof MetricError) throw completed
  return parseRunnerOutput(runner, completed)
}

export async function runRunnersConcurrently(rows: LedgerRow[], since: string): Promise<FinishedRunners> {
  const runners = rows.map((row) => splitMetric(row.metric)).filter(([kind]) => kind === "run").map(([, runner]) => runner)
  return runNamedRunnersConcurrently(runners, since)
}

export async function runNamedRunnersConcurrently(runners: string[], since: string): Promise<FinishedRunners> {
  const waiting = [...runnerPaths(runners)]
  const finished = new Map<string, RunResult | MetricError>()
  const worker = async (): Promise<void> => {
    for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) {
      const [runner, runnerPath] = next
      finished.set(runner, await runRunnerAsync(runner, runnerPath, since))
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_RUNNERS, waiting.length) }, worker))
  return finished
}

function runnerPaths(runners: string[]): Map<string, string> {
  const paths = new Map<string, string>()
  for (const runner of runners) {
    const runnerPath = findRunner(runner)
    if (runnerPath !== null) paths.set(runner, runnerPath)
  }
  return paths
}

function runRunnerBlocking(runner: string, runnerPath: string, since: string): RunResult {
  try {
    return runProcess([runnerPath, "--since", since], { timeoutSeconds: RUNNER_TIMEOUT_SECONDS })
  } catch (error) {
    throw couldNotRun(runner, runnerPath, error)
  }
}

async function runRunnerAsync(runner: string, runnerPath: string, since: string): Promise<RunResult | MetricError> {
  try {
    return await runProcessAsync([runnerPath, "--since", since], { timeoutSeconds: RUNNER_TIMEOUT_SECONDS })
  } catch (error) {
    return couldNotRun(runner, runnerPath, error)
  }
}

function couldNotRun(runner: string, runnerPath: string, error: unknown): MetricError {
  if (error instanceof TimeoutExpired) return new MetricError(`runner ${runner} could not run: ${error.message}`)
  if (isSystemError(error)) return new MetricError(`runner ${runner} could not run: spawnSync ${runnerPath} ${error.code}`)
  throw error
}

function parseRunnerOutput(runner: string, completed: RunResult): MetricItems {
  if (completed.returncode !== 0) throw new MetricError(`runner ${runner} exited ${completed.returncode}: ${stderrExcerpt(completed)}`)
  let payload: JsonValue
  try {
    payload = parseJson(completed.stdout)
  } catch (error) {
    if (error instanceof SyntaxError) throw new MetricError(`runner ${runner} did not print one JSON object`)
    throw error
  }
  const count = isJsonObject(payload) ? payload["count"] : undefined
  const items = isJsonObject(payload) ? payload["items"] : undefined
  if (!Number.isInteger(count) || !Array.isArray(items)) throw new MetricError(`runner ${runner} must print {"count": int, "items": [...]}`)
  const extraKeys = Object.fromEntries(Object.entries(payload as JsonObject).filter(([key]) => !RESULT_KEYS.has(key)))
  return Object.keys(extraKeys).length === 0 ? [count as number, items] : [count as number, items, extraKeys]
}

export function defectRunnerNames(overlayDir: string): string[] {
  const runnerDir = path.join(overlayDir, "measure", "metrics")
  const names = isDir(runnerDir) ? fs.readdirSync(runnerDir).sort() : []
  return names.filter((name) => name.startsWith(DEFECT_RUNNER_PREFIX) && isRunnerFile(path.join(runnerDir, name)))
}

export function findRunner(runner: string): string | null {
  const candidates = [env.keelHome(), env.overlayDir()].map((root) => path.join(root, "measure", "metrics", runner))
  return candidates.find(isRunnerFile) ?? null
}

function isRunnerFile(file: string): boolean {
  return isFile(file) && isExecutable(file)
}

function existenceItems(argument: string): MetricItems {
  const parts = splitAtMost(argument, ":", 2)
  if (parts.length !== 3) throw new MetricError("exists metric needs <repo path>:<ref>:<path>")
  const [repo, ref, path] = parts as [string, string, string]
  const objectName = `${ref}:${path}`
  if (!gitSucceeds(expandHome(repo), ["cat-file", "-e", objectName])) return [0, []]
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
  return Array.from(completed.stderr.trim()).slice(0, STDERR_EXCERPT_CHARS).join("")
}
