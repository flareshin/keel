import fs from "node:fs"
import path from "node:path"

import { pythonJsonDumps } from "../../../measure/lib/measurekit/pyjson.ts"
import type { PyValue } from "../../../measure/lib/measurekit/pyvalue.ts"

interface Scenario {
  events?: unknown[]
  exit?: number
  writes?: Record<string, string>
  sleep?: number
  leave_project_dir?: boolean
  rounds?: Scenario[]
}

const SCENARIO_DIR = process.env["KEEL_TEST_SCENARIOS"] as string
const CALLS_LOG = path.join(SCENARIO_DIR, "calls.jsonl")
const SECOND_MS = 1000

function firstLine(text: string): string {
  const end = text.indexOf("\n")
  return (end < 0 ? text : text.slice(0, end)).trim()
}

function previousCalls(name: string): number {
  if (!fs.existsSync(CALLS_LOG)) return 0
  const lines = fs.readFileSync(CALLS_LOG, "utf8").split("\n").filter((line) => line.trim() !== "")
  return lines.filter((line) => (JSON.parse(line) as { scenario: string }).scenario === name).length
}

function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * SECOND_MS)
}

function main(): number {
  const name = firstLine(fs.readFileSync(0, "utf8"))
  const roundIndex = previousCalls(name)
  const call = { argv: process.argv.slice(2), cwd: process.cwd(), scenario: name, auto_memory_disabled: process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] ?? null }
  fs.appendFileSync(CALLS_LOG, pythonJsonDumps(call as unknown as PyValue) + "\n")
  let scenario = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, `${name}.json`), "utf8")) as Scenario
  if (scenario.rounds !== undefined && scenario.rounds.length > 0) scenario = scenario.rounds[roundIndex % scenario.rounds.length] as Scenario
  for (const [relativePath, content] of Object.entries(scenario.writes ?? {})) {
    const target = path.join(process.cwd(), relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  if (scenario.leave_project_dir) {
    const slug = fs.realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, "-")
    fs.mkdirSync(path.join(process.env["CLAUDE_CONFIG_DIR"] as string, "projects", slug), { recursive: true })
  }
  sleep(scenario.sleep ?? 0)
  for (const event of scenario.events ?? []) fs.writeSync(1, pythonJsonDumps(event as PyValue) + "\n")
  return scenario.exit ?? 0
}

process.exitCode = main()
