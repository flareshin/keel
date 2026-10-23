#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
  choiceOption, EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, exactlyOnePositional, flagOption, parseCommandLine, positiveIntOption, printJson,
  runMain, stringOption, usageError,
} from "../lib/measurekit/cli.ts"
import type { CommandSpec } from "../lib/measurekit/cli.ts"
import { appendJsonl, readJsonl } from "../lib/measurekit/datafiles.ts"
import { compactUtcSeconds, utcSeconds } from "../lib/measurekit/dates.ts"
import * as env from "../lib/measurekit/env.ts"
import { InvalidUtf8Error, isDir, isSystemError, readUtf8, resolveLinks, splitLines } from "../lib/measurekit/files.ts"
import { GitError } from "../lib/measurekit/gitutil.ts"
import { displayText, isJsonObject, parseJson, stringifySorted } from "../lib/measurekit/json.ts"
import type { JsonObject, JsonValue } from "../lib/measurekit/json.ts"
import { allRows, loadLedgersFrom } from "../lib/measurekit/ledger.ts"
import { Case, CaseError, loadCases, selectCases, SPLITS, splitGaps } from "./lib/evalkit/cases.ts"
import { faultReason, graderCommit, LEFTOVER_FAULT, runPasses } from "./lib/evalkit/grade.ts"
import { cliConfigDir, configFingerprint, isKeelLive, suiteEvalId } from "./lib/evalkit/liveconfig.ts"
import { CLAUDE_BINARY, claudeCommand, findOnPath, runOnce } from "./lib/evalkit/runner.ts"
import type { RunRecord } from "./lib/evalkit/runner.ts"
import { RunFacts, summarizeStream } from "./lib/evalkit/stream.ts"
import { CaseVerdict, splitVerdict, suitePasses } from "./lib/evalkit/verdict.ts"
import type { SplitVerdict } from "./lib/evalkit/verdict.ts"

const DEFAULT_REPEAT = 3
const DEFAULT_TIMEOUT_SECONDS = 300
const PARTIAL_SUFFIX = "-partial"
const CASE_SUFFIX = ".case"
const SKILL_ENFORCEMENT = "skill:"
const RAW_DIR_PREFIX = "keel-eval-"
const RUN_RECORD_KEYS = ["case", "run", "kind", "exit", "timed_out", "changed"]
const JSON_INDENT = 2
const COMMAND: CommandSpec = {
  prog: "measure/evals/eval",
  usage: "measure/evals/eval [-h] [--regrade RAW_DIR] [--model MODEL] [--split {train,holdout}] [--case CASE] [--repeat N] [--timeout-seconds S] [--dry-run] ID",
  description: "Grade a skill's behavior on its trajectory cases.",
  argumentHelp: [
    ["ID", "ledger row id whose cases to run, e.g. K4"],
    ["--regrade RAW_DIR", "grade an earlier run's raw dir again with the current grader; calls no claude"],
    ["--model MODEL", "model to pin for this baseline (passed to claude --model); required unless --regrade"],
    ["--split {train,holdout}", "run one split only (writes <id>-partial, never <id>)"],
    ["--case CASE", "run one case only (writes <id>-partial, never <id>)"],
    ["--repeat N", `runs per case (default ${DEFAULT_REPEAT})`],
    ["--timeout-seconds S", `per-run limit (default ${DEFAULT_TIMEOUT_SECONDS})`],
    ["--dry-run", "print the plan and the command; run nothing"],
  ],
  options: {
    regrade: { type: "string" }, model: { type: "string" }, split: { type: "string" }, case: { type: "string" },
    repeat: { type: "string" }, "timeout-seconds": { type: "string" }, "dry-run": { type: "boolean" },
  },
}

class PlanError extends Error {}

interface EvalArgs {
  id: string
  regrade: string | undefined
  model: string | undefined
  split: string | undefined
  caseId: string | undefined
  repeat: number
  timeoutSeconds: number
  dryRun: boolean
}

interface Plan {
  evalId: string
  skill: string
  cases: Case[]
  fullRun: boolean
  repeat: number
  model: string
  command: string[]
  fixture: string
  configDir: string
  keelLive: boolean
  timeoutSeconds: number
}

interface RunResult {
  case: Case
  index: number
  record: RunRecord
  fault: string | null
  passed: boolean
}

type Provenance = JsonObject

function summaryEvalId(plan: Plan): string {
  return plan.fullRun ? suiteEvalId(plan.evalId, plan.keelLive) : plan.evalId + PARTIAL_SUFFIX
}

function main(argv: string[]): number {
  const args = parseEvalArgs(argv)
  if (args.regrade) return regrade(args.id, args.regrade)
  let plan: Plan
  try {
    plan = buildPlan(args)
  } catch (error) {
    if (!(error instanceof PlanError)) throw error
    process.stderr.write(`eval: ${error.message}\n`)
    return EXIT_USAGE
  }
  const configFault = configDirFault(plan.configDir)
  if (configFault) {
    process.stderr.write(`eval: fault: ${configFault}\n`)
    printJson({ eval_id: summaryEvalId(plan), rule_id: plan.evalId, pass: null, written: false, faults: [{ reason: configFault }] })
    return EXIT_NEGATIVE
  }
  describePlan(plan)
  if (args.dryRun) {
    printJson(planReport(plan))
    return EXIT_OK
  }
  const rawDir = createRawDir(plan)
  const results = runPlan(plan, rawDir)
  saveConfig(rawDir, plan, results)
  return gradeAndWrite(plan, rawDir, results, {}, {})
}

function parseEvalArgs(argv: string[]): EvalArgs {
  const parsed = parseCommandLine(COMMAND, argv)
  const args: EvalArgs = {
    id: exactlyOnePositional(COMMAND, parsed, "ID"),
    regrade: stringOption(parsed, "regrade"),
    model: stringOption(parsed, "model"),
    split: choiceOption(COMMAND, "--split", stringOption(parsed, "split"), SPLITS),
    caseId: stringOption(parsed, "case"),
    repeat: positiveIntOption(COMMAND, "--repeat", stringOption(parsed, "repeat"), DEFAULT_REPEAT),
    timeoutSeconds: positiveIntOption(COMMAND, "--timeout-seconds", stringOption(parsed, "timeout-seconds"), DEFAULT_TIMEOUT_SECONDS),
    dryRun: flagOption(parsed, "dry-run"),
  }
  if (args.regrade && (args.model || args.split || args.caseId || args.dryRun)) {
    usageError(COMMAND, "--regrade takes its model and cases from the raw dir; drop --model, --split, --case and --dry-run")
  }
  if (!args.regrade && !args.model) usageError(COMMAND, "--model is required")
  return args
}

function buildPlan(args: EvalArgs): Plan {
  const keelHome = env.keelHome()
  const overlayDir = env.overlayDir()
  const evalId = args.id
  const skill = skillEnforcing(evalId, keelHome, overlayDir)
  const split = args.split
  const caseId = args.caseId
  let cases: Case[]
  try {
    cases = selectCases(loadCases(evalId, [keelHome, overlayDir]), split, caseId)
  } catch (error) {
    if (error instanceof CaseError) throw new PlanError(error.message)
    throw error
  }
  if (cases.length === 0) throw new PlanError(`no case selected (split=${split || "all"}, case=${caseId || "all"})`)
  const fullRun = split === undefined && caseId === undefined
  if (fullRun && splitGaps(cases).length > 0) throw new PlanError("a full run needs an ambiguous and a clear case in each split: " + splitGaps(cases).join("; "))
  const fixture = path.join(keelHome, "measure", "evals", evalId, "repo")
  if (!isDir(fixture)) throw new PlanError(`no fixture repo at ${fixture}`)
  if (findOnPath(CLAUDE_BINARY) === null) throw new PlanError(`no \`${CLAUDE_BINARY}\` on PATH`)
  const configDir = cliConfigDir()
  const model = args.model as string
  return {
    evalId, skill, cases, fullRun, repeat: args.repeat, model, command: claudeCommand(model), fixture, configDir,
    keelLive: isKeelLive(configDir, keelHome, skill), timeoutSeconds: args.timeoutSeconds,
  }
}

function skillEnforcing(evalId: string, keelHome: string, overlayDir: string): string {
  const row = allRows(loadLedgersFrom(keelHome, overlayDir)).find((candidate) => candidate.id === evalId)
  if (row === undefined) throw new PlanError(`no ledger row with id ${JSON.stringify(evalId)}`)
  if (!row.enforcedAt.startsWith(SKILL_ENFORCEMENT)) throw new PlanError(`ledger row ${evalId} is enforced at ${row.enforcedAt}, not by a skill`)
  return row.enforcedAt.slice(SKILL_ENFORCEMENT.length)
}

function configDirFault(configDir: string): string | null {
  const dataDir = env.dataDir()
  if (resolveLinks(configDir) !== resolveLinks(dataDir)) {
    return `CLI config dir ${configDir} differs from KEEL_DATA_DIR ${dataDir}; which config is under test is ambiguous`
  }
  return null
}

function describePlan(plan: Plan): void {
  const perSplit = SPLITS.map((split) => `${split} ${plan.cases.filter((candidate) => candidate.split === split).length}`).join(", ")
  process.stderr.write(
    `eval ${plan.evalId}: ${plan.cases.length} cases (${perSplit}) x ${plan.repeat} = ${plan.cases.length * plan.repeat} runs, ` +
    `model ${plan.model}, keel ${plan.keelLive ? "live" : "not live"}; writes ${summaryEvalId(plan)}\n`,
  )
}

function planReport(plan: Plan): JsonObject {
  return {
    eval_id: summaryEvalId(plan), rule_id: plan.evalId, keel_live: plan.keelLive, config_dir: plan.configDir,
    full_run: plan.fullRun, repeat: plan.repeat, model: plan.model, runs: plan.cases.length * plan.repeat,
    cases: plan.cases.map((candidate) => ({ id: candidate.id, split: candidate.split, kind: candidate.kind })),
    command: plan.command, fixture: plan.fixture, timeout_seconds: plan.timeoutSeconds,
  }
}

function createRawDir(plan: Plan): string {
  const stamp = compactUtcSeconds(new Date())
  const rawDir = path.join(env.logsDir(), `${RAW_DIR_PREFIX}${plan.evalId}-${stamp}-${randomBytes(2).toString("hex")}`)
  fs.mkdirSync(rawDir, { recursive: true })
  saveConfig(rawDir, plan, [])
  return rawDir
}

function runPlan(plan: Plan, rawDir: string): RunResult[] {
  const results: RunResult[] = []
  for (const planned of plan.cases) {
    for (let index = 1; index <= plan.repeat; index++) {
      const record = runOnce(planned.prompt, plan.fixture, plan.command, plan.configDir, plan.timeoutSeconds)
      const result = graded(planned, index, record, plan.timeoutSeconds)
      saveRun(rawDir, result)
      const outcome = result.fault ? "FAULT " + result.fault : result.passed ? "pass" : "fail"
      process.stderr.write(`  ${planned.id} ${index}/${plan.repeat}: ${outcome}\n`)
      results.push(result)
    }
  }
  return results
}

function regrade(evalId: string, rawDir: string): number {
  let loaded
  let grader: string
  try {
    loaded = loadRawDir(evalId, rawDir)
    grader = graderCommit(env.CHECKOUT_ROOT)
  } catch (error) {
    if (error instanceof PlanError || error instanceof GitError || isSystemError(error)) {
      process.stderr.write(`eval: ${(error as Error).message}\n`)
      return EXIT_USAGE
    }
    throw error
  }
  const { plan, results, leftoverUnknown } = loaded
  if (leftoverUnknown.length > 0) {
    process.stderr.write(`eval: ${rawDir} recorded no leftover project dir check for ${leftoverUnknown.join(", ")}; graded without it\n`)
  }
  const provenance = { regraded_from: path.basename(path.normalize(rawDir)), grader }
  return gradeAndWrite(plan, rawDir, results, provenance, { leftover_unknown: leftoverUnknown })
}

function loadRawDir(evalId: string, rawDir: string): { plan: Plan; results: RunResult[]; leftoverUnknown: string[] } {
  const config = readJsonObject(path.join(rawDir, "config.json"))
  if (config["eval_id"] !== evalId) throw new PlanError(`${rawDir} holds a ${displayText(config["eval_id"])} run, not ${evalId}`)
  const keelHome = env.keelHome()
  const overlayDir = env.overlayDir()
  const byId = new Map<string, Case>()
  try {
    for (const loadedCase of loadCases(evalId, [keelHome, overlayDir])) byId.set(loadedCase.id, loadedCase)
  } catch (error) {
    if (error instanceof CaseError) throw new PlanError(error.message)
    throw error
  }
  const configCases = config["cases"] as string[]
  const missing = configCases.filter((caseId) => !byId.has(caseId))
  if (missing.length > 0) throw new PlanError(`${rawDir}: case(s) ${missing.join(", ")} are no longer in the case files`)
  const records = readRuns(rawDir)
  const strays = [...new Set(records.map(recordCase).filter((caseId) => !configCases.includes(caseId)))].sort()
  const stale = [...new Set(records.filter((record) => byId.has(recordCase(record)) && record["kind"] !== byId.get(recordCase(record))?.kind).map(recordCase))].sort()
  if (strays.length > 0 || stale.length > 0) throw new PlanError(`${rawDir}: run(s) of case(s) ${[...strays, ...stale].join(", ")} do not match the case files`)
  const runsPerCase = new Map<string, number>()
  for (const record of records) runsPerCase.set(recordCase(record), (runsPerCase.get(recordCase(record)) ?? 0) + 1)
  const configured = configCases.map((caseId) => byId.get(caseId) as Case)
  const repeat = config["repeat"] as number
  const fullRun =
    !(config["summary_eval_id"] as string).endsWith(PARTIAL_SUFFIX) &&
    new Set(configCases).size === byId.size && configCases.every((caseId) => byId.has(caseId)) &&
    configured.every((configuredCase) => runsPerCase.get(configuredCase.id) === repeat) && splitGaps(configured).length === 0
  const timeoutSeconds = "timeout_seconds" in config ? (config["timeout_seconds"] as number) : DEFAULT_TIMEOUT_SECONDS
  const plan: Plan = {
    evalId, skill: skillEnforcing(evalId, keelHome, overlayDir), cases: configured.filter((configuredCase) => (runsPerCase.get(configuredCase.id) ?? 0) > 0),
    fullRun, repeat, model: (config["model_observed"] || config["model_requested"]) as string, command: config["command"] as string[],
    fixture: "", configDir: config["config_dir"] as string, keelLive: config["keel_live"] as boolean, timeoutSeconds,
  }
  const results = records.map((record) => regradedRun(rawDir, byId.get(recordCase(record)) as Case, record, plan.timeoutSeconds))
  const leftoverUnknown = records.filter(leftoverUnrecorded).map((record) => runName(recordCase(record), record["run"] as number))
  return { plan, results, leftoverUnknown }
}

function recordCase(record: JsonObject): string {
  return record["case"] as string
}

function readRuns(rawDir: string): JsonObject[] {
  const runsPath = path.join(rawDir, "runs.jsonl")
  if (!fs.existsSync(runsPath) || !fs.statSync(runsPath).isFile()) throw new PlanError(`no runs.jsonl in ${rawDir}`)
  const { records, malformed: unreadable } = readJsonl(runsPath)
  const malformed = unreadable + records.filter((record) => !RUN_RECORD_KEYS.every((key) => key in record)).length
  if (malformed > 0) throw new PlanError(`${runsPath} has ${malformed} malformed line(s)`)
  if (records.length === 0) throw new PlanError(`${runsPath} holds no run`)
  return records
}

function regradedRun(rawDir: string, regradedCase: Case, record: JsonObject, timeoutSeconds: number): RunResult {
  const stem = path.join(rawDir, runName(regradedCase.id, record["run"] as number))
  const streamText = readRawText(stem + ".stream.jsonl")
  const diff = readRawText(stem + ".diff")
  const facts = new RunFacts({
    stream: summarizeStream(splitLines(streamText)), exitCode: record["exit"] as number, timedOut: record["timed_out"] as boolean,
    changed: record["changed"] as boolean, leftoverProjectDir: recordedLeftover(record),
  })
  return graded(regradedCase, record["run"] as number, { facts, streamText, diff }, timeoutSeconds)
}

function recordedLeftover(record: JsonObject): string | null {
  if ("leftover_project_dir" in record) return record["leftover_project_dir"] as string | null
  const fault = typeof record["fault"] === "string" ? record["fault"] : ""
  return fault.startsWith(LEFTOVER_FAULT) ? fault.slice(LEFTOVER_FAULT.length) : null
}

function leftoverUnrecorded(record: JsonObject): boolean {
  const fault = record["fault"]
  return !("leftover_project_dir" in record) && fault !== undefined && fault !== null && !(fault as string).startsWith(LEFTOVER_FAULT)
}

function graded(gradedCase: Case, index: number, record: RunRecord, timeoutSeconds: number): RunResult {
  const fault = faultReason(record.facts, timeoutSeconds)
  return { case: gradedCase, index, record, fault, passed: fault === null && runPasses(gradedCase, record.facts) }
}

function gradeAndWrite(plan: Plan, rawDir: string, results: RunResult[], provenance: Provenance, notes: JsonObject): number {
  const verdicts = plan.cases.map((planned) => new CaseVerdict(planned, results.filter((result) => result.case === planned).map((result) => result.passed)))
  const splits = SPLITS.map((split) => splitVerdict(split, verdicts))
  const faults = results.filter((result) => result.fault)
  const model = observedModel(results) || plan.model
  if (faults.length === 0) appendEvalLines(plan, verdicts, splits, model, provenance)
  const report = buildReport(plan, rawDir, verdicts, splits, faults, model, skillDiagnostic(plan, results))
  Object.assign(report, notes)
  printJson(report)
  printSummary(report, rawDir)
  return report["pass"] === true ? EXIT_OK : EXIT_NEGATIVE
}

function saveRun(rawDir: string, result: RunResult): void {
  const stem = path.join(rawDir, runName(result.case.id, result.index))
  const facts = result.record.facts
  writeText(stem + ".stream.jsonl", result.record.streamText)
  writeText(stem + ".diff", result.record.diff)
  writeText(stem + ".final.txt", facts.finalText ?? "")
  appendJsonl(path.join(rawDir, "runs.jsonl"), {
    case: result.case.id, run: result.index, kind: result.case.kind, exit: facts.exitCode, timed_out: facts.timedOut, changed: facts.changed,
    asked_tool: facts.askedTool, tried_to_change: facts.triedToChange, denied_tools: facts.stream.deniedTools, skill_calls: facts.stream.skillCalls,
    leftover_project_dir: facts.leftoverProjectDir, fault: result.fault, pass: result.passed,
  })
}

function saveConfig(rawDir: string, plan: Plan, results: RunResult[]): void {
  const firstInit = results.map((result) => result.record.facts.stream.init).find((init) => init !== null) ?? {}
  const config: JsonObject = {
    eval_id: plan.evalId, summary_eval_id: summaryEvalId(plan), keel_live: plan.keelLive, config_dir: plan.configDir, keel_home: env.keelHome(),
    model_requested: plan.model, model_observed: firstInit["model"] ?? null, cli_version: firstInit["claude_code_version"] ?? null,
    repeat: plan.repeat, cases: plan.cases.map((planned) => planned.id), command: plan.command, timeout_seconds: plan.timeoutSeconds,
    ...configFingerprint(plan.configDir, plan.skill),
  }
  writeText(path.join(rawDir, "config.json"), stringifySorted(config, JSON_INDENT) + "\n")
  writeText(path.join(rawDir, "skill-diagnostic.json"), stringifySorted(skillDiagnostic(plan, results), JSON_INDENT) + "\n")
}

function skillDiagnostic(plan: Plan, results: RunResult[]): JsonObject {
  const ambiguous = results.filter((result) => !result.case.isClear)
  const clear = results.filter((result) => result.case.isClear)
  return {
    skill: plan.skill,
    ambiguous_runs: ambiguous.length, ambiguous_fired: ambiguous.filter((result) => result.record.facts.fired(plan.skill)).length,
    clear_runs: clear.length, clear_false_fires: clear.filter((result) => result.record.facts.fired(plan.skill)).length,
  }
}

function observedModel(results: RunResult[]): string | null {
  for (const result of results) {
    const init = result.record.facts.stream.init
    if (init !== null) return (init["model"] as string | undefined) ?? null
  }
  return null
}

function appendEvalLines(plan: Plan, verdicts: CaseVerdict[], splits: SplitVerdict[], model: string, provenance: Provenance): void {
  const evalsLog = path.join(env.logsDir(), "keel-evals.jsonl")
  const ts = utcSeconds(new Date())
  for (const verdict of verdicts) {
    appendJsonl(evalsLog, { ts, eval_id: plan.evalId + CASE_SUFFIX, rule_id: plan.evalId, case: verdict.case.id, pass: verdict.passed, model, ...provenance })
  }
  const counts = splits.map((split) => `${split.split}=${split.passedCases}/${split.cases}`).join(" ")
  appendJsonl(evalsLog, {
    ts, eval_id: summaryEvalId(plan), rule_id: plan.evalId, case: `${plan.fullRun ? "suite" : "subset"} ${counts}`, pass: suitePasses(splits), model, ...provenance,
  })
}

function buildReport(plan: Plan, rawDir: string, verdicts: CaseVerdict[], splits: SplitVerdict[], faults: RunResult[], model: string, diagnostic: JsonObject): JsonObject {
  return {
    eval_id: summaryEvalId(plan), rule_id: plan.evalId,
    pass: faults.length > 0 ? null : suitePasses(splits), written: faults.length === 0, model, raw_dir: rawDir,
    splits: Object.fromEntries(splits.map((split) => [split.split, { cases: split.cases, passed: split.passedCases, pass: split.passed }])),
    cases: verdicts.map((verdict) => ({ id: verdict.case.id, split: verdict.case.split, kind: verdict.case.kind, runs: verdict.runs, pass: verdict.passed })),
    faults: faults.map((result) => ({ case: result.case.id, run: result.index, reason: result.fault })),
    skill: diagnostic,
  }
}

function printSummary(report: JsonObject, rawDir: string): void {
  const splitReports = report["splits"] as { [split: string]: JsonObject }
  const splits = Object.entries(splitReports).map(([name, split]) => `${name} ${split["passed"]}/${split["cases"]}`).join(" ")
  const faults = report["faults"] as JsonValue[]
  const verdict = faults.length > 0
    ? `FAULT (${faults.length} run(s)); nothing written`
    : `${report["pass"] ? "PASS" : "FAIL"}; wrote ${report["eval_id"]}`
  process.stderr.write(`eval ${report["rule_id"]}: ${splits} -> ${verdict}; raw: ${rawDir}\n`)
}

function runName(caseId: string, run: number): string {
  return `${caseId}-${run}`
}

function readJsonObject(file: string): JsonObject {
  let value: JsonValue
  try {
    value = parseJson(readUtf8(file))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error || isSystemError(error)) throw new PlanError(`cannot read ${file}: ${error.message}`)
    throw error
  }
  if (!isJsonObject(value)) throw new PlanError(`cannot read ${file}: not an object`)
  return value
}

function readRawText(file: string): string {
  try {
    return readUtf8(file)
  } catch (error) {
    if (isSystemError(error)) throw new PlanError(`cannot read ${file}: ${error.message}`)
    throw error
  }
}

function writeText(file: string, text: string): void {
  fs.writeFileSync(file, text, "utf8")
}

runMain(main)
