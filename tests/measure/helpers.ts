import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { addDays, todayLocal } from "../../measure/lib/measurekit/pydate.ts"

export const CHECKOUT = path.dirname(path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))))
export const MEASURE_DIR = path.join(CHECKOUT, "measure")
export const GITHOOKS_DIR = path.join(CHECKOUT, "githooks")
export const LEDGER_COLUMNS = [
  "id", "scope", "type", "statement", "layer", "enforced_at", "why_not_stronger",
  "justification", "incidents", "metric", "review_by", "grace_until", "status",
] as const
export const TODAY = todayLocal()
export const FUTURE = addDays(TODAY, 30)
export const PAST = addDays(TODAY, -30)
export const NOW_TS = TODAY + "T09:00:00Z"
const LINK_STUB_CLEAN = '#!/bin/bash\necho \'{"actions":[],"problems":[]}\'\n'
const CLAUDE_STUB = '#!/bin/bash\necho "$*" >> "$(dirname "$0")/claude.calls"\ncat "$(dirname "$0")/plugins.json"\n'
export const DEMO_HOOK = [
  "import json, os, sys",
  "command = json.load(sys.stdin)['tool_input']['command']",
  "if not command.startswith('bad '):",
  "    sys.exit(0)",
  "logs = os.path.join(os.environ['KEEL_DATA_DIR'], 'logs')",
  "os.makedirs(logs, exist_ok=True)",
  "with open(os.path.join(logs, 'keel-fires.jsonl'), 'a') as handle:",
  "    handle.write(json.dumps({'rule_id': command.split()[1], 'outcome': 'deny', 'hook': 'demo'}) + '\\n')",
  "sys.exit(2)",
  "",
].join("\n")

const COLOR_VARIABLES = ["FORCE_COLOR", "NO_COLOR", "PYTHON_COLORS"]

const FIXED_COMMIT_DATES = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" }

export function isCallerSpecificVariable(name: string): boolean {
  return name.startsWith("KEEL_") || name.startsWith("GIT_") || COLOR_VARIABLES.includes(name)
}

export type LedgerRowValues = Record<(typeof LEDGER_COLUMNS)[number], string>
export type Completed = { status: number | null; stdout: string; stderr: string }

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8")
}

export function ledgerRow(rowId: string, overrides: Partial<LedgerRowValues> = {}): LedgerRowValues {
  return {
    id: rowId, scope: "core", type: "knowledge", statement: "A demo rule.",
    layer: "hook", enforced_at: "hook:demo", why_not_stronger: "-", justification: "-",
    incidents: "docs/incidents/one.md,docs/incidents/two.md", metric: "fires:" + rowId,
    review_by: FUTURE, grace_until: "-", status: "active",
    ...overrides,
  }
}

export function charterRow(rowId: string = "K1", overrides: Partial<LedgerRowValues> = {}): LedgerRowValues {
  return ledgerRow(rowId, { scope: "charter", justification: "Evidence from the previous harness.", incidents: "-", review_by: "-", ...overrides })
}

export class MeasureSandbox {
  readonly root: string
  readonly keel: string
  readonly overlay: string
  readonly data: string
  readonly gitconfig: string
  readonly linkStub: string
  readonly claudeStub: string
  env: Record<string, string>

  constructor() {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-measure-test-")))
    this.keel = path.join(this.root, "keel")
    this.overlay = path.join(this.root, "overlay")
    this.data = path.join(this.root, "data")
    for (const directory of [this.keel, this.overlay, this.data, path.join(this.root, "home")]) fs.mkdirSync(directory, { recursive: true })
    this.gitconfig = path.join(this.root, "gitconfig")
    fs.writeFileSync(this.gitconfig, "[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n")
    this.linkStub = this.write("stubs/link", LINK_STUB_CLEAN, true)
    this.claudeStub = this.write("stubs/claude", CLAUDE_STUB, true)
    this.installPlugins([])
    this.env = this.isolatedEnv()
    if (!this.env["KEEL_DATA_DIR"]?.startsWith(this.root + path.sep)) throw new Error("data dir must be inside the sandbox")
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true })
  }

  private isolatedEnv(): Record<string, string> {
    const kept = Object.entries(process.env).filter(([key]) => !isCallerSpecificVariable(key))
    return {
      ...(Object.fromEntries(kept) as Record<string, string>),
      KEEL_HOME: this.keel, KEEL_OVERLAY_DIR: this.overlay, KEEL_DATA_DIR: this.data,
      HOME: path.join(this.root, "home"), GIT_CONFIG_GLOBAL: this.gitconfig, GIT_CONFIG_NOSYSTEM: "1",
      KEEL_GH: path.join(this.root, "stubs", "gh"), KEEL_LINK: this.linkStub, KEEL_CLAUDE: this.claudeStub,
    }
  }

  installPlugins(plugins: { id: string; installPath: string }[]): void {
    this.write("stubs/plugins.json", JSON.stringify(plugins))
  }

  write(relativePath: string, content: string, executable: boolean = false): string {
    const file = path.join(this.root, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    if (executable) fs.chmodSync(file, 0o755)
    return file
  }

  writeLedger(relativePath: string, rows: LedgerRowValues[]): string {
    const lines = [LEDGER_COLUMNS.join("\t"), ...rows.map((row) => LEDGER_COLUMNS.map((column) => row[column]).join("\t"))]
    return this.write(relativePath, lines.join("\n") + "\n")
  }

  appendLog(name: string, record: object): void {
    const file = path.join(this.data, "logs", name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + "\n")
  }

  fire(ruleId: string, ts: string = NOW_TS, outcome: string = "deny"): void {
    this.appendLog("keel-fires.jsonl", { ts, rule_id: ruleId, hook: "ship-gate", outcome, session: "-" })
  }

  writeLexicon(): void {
    this.write("overlay/boundary/lexicon.txt", "ACMECORP\nTKT-\n")
    this.write("overlay/boundary/regex.txt", "\\bTKT-\\d{3,}\\b\n\\b10\\.250\\.\\d{1,3}\\.\\d{1,3}\\b\n")
  }

  git(repo: string, ...args: string[]): string {
    const completed = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...this.env, ...FIXED_COMMIT_DATES } })
    if (completed.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${completed.stderr}`)
    return completed.stdout
  }

  gitInput(repo: string, args: string[], input: string): string {
    return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: this.env, input }).stdout
  }

  initRepo(repo: string, origin: string = "https://example.invalid/example/keel.git"): void {
    this.git(repo, "init", "-q")
    this.git(repo, "remote", "add", "origin", origin)
  }

  commitAll(repo: string, message: string = "Add files"): string {
    this.git(repo, "add", "-A")
    this.git(repo, "commit", "-q", "--no-verify", "-m", message)
    return this.git(repo, "rev-parse", "HEAD").trim()
  }

  bashFixture(command: string, expect?: string): string {
    const fixture: Record<string, unknown> = { payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "{{TMP}}" } }
    if (expect) fixture["expect"] = expect
    return JSON.stringify(fixture)
  }

  registerHooks(hooks: object): void {
    this.write("data/settings.json", JSON.stringify({ hooks }))
  }

  seedDemoHook(): void {
    const script = this.write("keel/hooks/demo/demo.py", DEMO_HOOK)
    this.registerHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 " + script }] }] })
    for (const ruleId of ["K1", "C-demo"]) this.write(`keel/tests/hooks/fixtures/${ruleId}.bad.json`, this.bashFixture("bad " + ruleId, "deny"))
    this.write("keel/tests/hooks/fixtures/demo.good.json", this.bashFixture("ls"))
  }

  seedCleanKeel(): void {
    this.writeLedger("keel/ledger.tsv", [charterRow("K1"), ledgerRow("C-demo")])
    this.seedDemoHook()
    this.write("keel/docs/incidents/one.md", "First incident.\n")
    this.write("keel/docs/incidents/two.md", "Second incident.\n")
    this.write("keel/PRINCIPLES.md", "# Principles\n\n- [K1] An author never judges its own output.\n")
    this.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rules\n\n- [K1] Tagged.\n")
    this.fire("K1")
    this.fire("C-demo")
    this.writeLexicon()
    this.initRepo(this.keel)
    this.commitAll(this.keel)
  }

  lastLogLine(name: string): Record<string, unknown> {
    const lines = readText(path.join(this.data, "logs", name)).split("\n").filter((line) => line !== "")
    return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>
  }

  runMeasure(tool: string, args: string[] = [], cwd?: string): Completed {
    return spawnSync(process.execPath, [path.join(MEASURE_DIR, `${tool}.ts`), ...args], { encoding: "utf8", env: this.env, cwd: cwd ?? this.root })
  }

  runJson(tool: string, args: string[] = [], cwd?: string): [Completed, any] {
    const completed = this.runMeasure(tool, args, cwd)
    return [completed, completed.stdout.trim() ? JSON.parse(completed.stdout) : null]
  }
}
