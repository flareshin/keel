import fs from "node:fs"
import path from "node:path"

import { pythonJsonDumps } from "../../../../measure/lib/measurekit/pyjson.ts"
import type { PyValue } from "../../../../measure/lib/measurekit/pyvalue.ts"

interface Record_ {
  workflowName?: string
  status?: string
  startTime?: number
  result?: unknown
}

interface Round {
  records?: Record_[]
  record?: boolean
  status?: string
  result?: unknown
  sleep?: number
  exit?: number
}

const SCENARIO_DIR = process.env["KEEL_TEST_SCENARIOS"] as string
const CALLS_LOG = path.join(SCENARIO_DIR, "calls.jsonl")
const SECOND_MS = 1000

function previousCalls(): number {
  if (!fs.existsSync(CALLS_LOG)) return 0
  return fs.readFileSync(CALLS_LOG, "utf8").split("\n").filter((line) => line.trim() !== "").length
}

function recordsOf(round: Round): Record_[] {
  if (round.records !== undefined) return round.records
  if (round.record === false) return []
  return [{ status: round.status ?? "completed", result: round.result ?? null }]
}

function writeRecord(sessionId: string, index: number, record: Record_): void {
  const repo = fs.realpathSync(process.cwd())
  const directory = path.join(process.env["CLAUDE_CONFIG_DIR"] as string, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), sessionId, "workflows")
  fs.mkdirSync(directory, { recursive: true })
  const result = JSON.parse(JSON.stringify(record.result ?? null).replaceAll("{{REPO}}", repo))
  const body = { workflowName: record.workflowName ?? "lens-review", status: record.status ?? "completed", startTime: record.startTime ?? 1, result }
  fs.writeFileSync(path.join(directory, `wf_stub_${index}.json`), pythonJsonDumps(body as PyValue))
}

function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * SECOND_MS)
}

function main(): number {
  const prompt = fs.readFileSync(0, "utf8")
  const callIndex = previousCalls()
  fs.appendFileSync(CALLS_LOG, pythonJsonDumps({ argv: process.argv.slice(2), cwd: process.cwd(), prompt }) + "\n")
  const rounds = (JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, "review.json"), "utf8")) as { rounds: Round[] }).rounds
  const round = rounds[callIndex % rounds.length] as Round
  const sessionId = `session-${callIndex}`
  fs.writeSync(1, pythonJsonDumps({ type: "system", subtype: "init", session_id: sessionId, model: "stub-model" }) + "\n")
  recordsOf(round).forEach((record, index) => writeRecord(sessionId, index, record))
  sleep(round.sleep ?? 0)
  fs.writeSync(1, pythonJsonDumps({ type: "result", subtype: "success", result: "VERDICT: done" }) + "\n")
  return round.exit ?? 0
}

process.exitCode = main()
