import fs from "node:fs"
import path from "node:path"


interface Record_ {
  workflowName?: string
  status?: string
  startTime?: number
  result?: unknown
  args?: unknown
}

interface Round {
  records?: Record_[]
  record?: boolean
  status?: string
  result?: unknown
  args?: unknown
  sleep?: number
  exit?: number
  stderr?: string
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
  return [{ status: round.status ?? "completed", result: round.result ?? null, args: round.args }]
}

function writeRecord(sessionId: string, index: number, record: Record_): void {
  const repo = fs.realpathSync(process.cwd())
  const directory = path.join(process.env["CLAUDE_CONFIG_DIR"] as string, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), sessionId, "workflows")
  fs.mkdirSync(directory, { recursive: true })
  const withRepo = (value: unknown) => JSON.parse(JSON.stringify(value ?? null).replaceAll("{{REPO}}", repo))
  const body = { workflowName: record.workflowName ?? "lens-review", status: record.status ?? "completed", startTime: record.startTime ?? 1, result: withRepo(record.result), ...(record.args === undefined ? {} : { args: withRepo(record.args) }) }
  fs.writeFileSync(path.join(directory, `wf_stub_${index}.json`), JSON.stringify(body))
}

function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * SECOND_MS)
}

function main(): number {
  const prompt = fs.readFileSync(0, "utf8")
  const callIndex = previousCalls()
  fs.appendFileSync(CALLS_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, bgWaitCeiling: process.env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"] ?? null }) + "\n")
  const rounds = (JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, "review.json"), "utf8")) as { rounds: Round[] }).rounds
  const round = rounds[callIndex % rounds.length] as Round
  const sessionId = `session-${callIndex}`
  fs.writeSync(1, JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "stub-model" }) + "\n")
  recordsOf(round).forEach((record, index) => writeRecord(sessionId, index, record))
  if (round.stderr !== undefined) fs.writeSync(2, round.stderr)
  sleep(round.sleep ?? 0)
  fs.writeSync(1, JSON.stringify({ type: "result", subtype: "success", result: "VERDICT: done" }) + "\n")
  return round.exit ?? 0
}

process.exitCode = main()
