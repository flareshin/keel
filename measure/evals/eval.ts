#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import fs from "node:fs"

import { ArgumentParser, positiveInt } from "../lib/measurekit/argparse.ts"
import type { ParsedArguments } from "../lib/measurekit/argparse.ts"
import { EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, printJson, runMain } from "../lib/measurekit/cli.ts"
import { appendJsonl, readJsonl } from "../lib/measurekit/datafiles.ts"
import * as env from "../lib/measurekit/env.ts"
import { GitError } from "../lib/measurekit/gitutil.ts"
import { allRows, loadLedgersFrom } from "../lib/measurekit/ledger.ts"
import { utcStamp } from "../lib/measurekit/pydate.ts"
import { isOsError, ValueError } from "../lib/measurekit/pyerrors.ts"
import { readText } from "../lib/measurekit/pyio.ts"
import { pythonJsonDumps, pythonJsonLoads } from "../lib/measurekit/pyjson.ts"
import { isDir, pyBasename, pyJoin, pyNormpath, realpath, which } from "../lib/measurekit/pypath.ts"
import { sortedByCodePoint, pySplitlines } from "../lib/measurekit/pystr.ts"
import { isJsonObject, pyRepr, pyStr, pyTruthy } from "../lib/measurekit/pyvalue.ts"
import type { JsonObject, PyValue } from "../lib/measurekit/pyvalue.ts"
import { Case, CaseError, loadCases, selectCases, SPLITS, splitGaps } from "./lib/evalkit/cases.ts"
import { faultReason, graderCommit, LEFTOVER_FAULT, runPasses } from "./lib/evalkit/grade.ts"
import { cliConfigDir, configFingerprint, isKeelLive, suiteEvalId } from "./lib/evalkit/liveconfig.ts"
import { CLAUDE_BINARY, claudeCommand, runOnce } from "./lib/evalkit/runner.ts"
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

class PlanError extends Error {}

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
  const args = parseArgs(argv)
  if (args["regrade"]) return regrade(args["id"] as string, args["regrade"] as string)
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
  if (args["dry_run"] === true) {
    printJson(planReport(plan))
    return EXIT_OK
  }
  const rawDir = createRawDir(plan)
  const results = runPlan(plan, rawDir)
  saveConfig(rawDir, plan, results)
  return gradeAndWrite(plan, rawDir, results, {}, {})
}

function parseArgs(argv: string[]): ParsedArguments {
  const parser = new ArgumentParser({
    prog: "measure/evals/eval",
    description: "Grade a skill's behavior on its trajectory cases.",
    arguments: [
      { flags: [], dest: "id", kind: "value", help: "ledger row id whose cases to run, e.g. K4" },
      { flags: ["--regrade"], dest: "regrade", kind: "value", metavar: "RAW_DIR", help: "grade an earlier run's raw dir again with the current grader; calls no claude" },
      { flags: ["--model"], dest: "model", kind: "value", help: "model to pin for this baseline (passed to claude --model); required unless --regrade" },
      { flags: ["--split"], dest: "split", kind: "value", choices: SPLITS, help: "run one split only (writes <id>-partial, never <id>)" },
      { flags: ["--case"], dest: "case", kind: "value", help: "run one case only (writes <id>-partial, never <id>)" },
      { flags: ["--repeat"], dest: "repeat", kind: "value", convert: positiveInt, typeName: "positive_int", defaultValue: DEFAULT_REPEAT, help: `runs per case (default ${DEFAULT_REPEAT})` },
      { flags: ["--timeout-seconds"], dest: "timeout_seconds", kind: "value", convert: positiveInt, typeName: "positive_int", defaultValue: DEFAULT_TIMEOUT_SECONDS, help: `per-run limit (default ${DEFAULT_TIMEOUT_SECONDS})` },
      { flags: ["--dry-run"], dest: "dry_run", kind: "flag", help: "print the plan and the command; run nothing" },
    ],
  })
  const args = parser.parse(argv)
  if (args["regrade"] && (args["model"] || args["split"] || args["case"] || args["dry_run"])) {
    parser.error("--regrade takes its model and cases from the raw dir; drop --model, --split, --case and --dry-run")
  }
  if (!args["regrade"] && !args["model"]) parser.error("--model is required")
  return args
}

function buildPlan(args: ParsedArguments): Plan {
  const keelHome = env.keelHome()
  const overlayDir = env.overlayDir()
  const evalId = args["id"] as string
  const skill = skillEnforcing(evalId, keelHome, overlayDir)
  const split = args["split"] as string | undefined
  const caseId = args["case"] as string | undefined
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
  const fixture = pyJoin(keelHome, "measure", "evals", evalId, "repo")
  if (!isDir(fixture)) throw new PlanError(`no fixture repo at ${fixture}`)
  if (which(CLAUDE_BINARY) === null) throw new PlanError(`no \`${CLAUDE_BINARY}\` on PATH`)
  const configDir = cliConfigDir()
  const model = args["model"] as string
  return {
    evalId, skill, cases, fullRun, repeat: args["repeat"] as number, model, command: claudeCommand(model), fixture, configDir,
    keelLive: isKeelLive(configDir, keelHome, skill), timeoutSeconds: args["timeout_seconds"] as number,
  }
}

function skillEnforcing(evalId: string, keelHome: string, overlayDir: string): string {
  const row = allRows(loadLedgersFrom(keelHome, overlayDir)).find((candidate) => candidate.id === evalId)
  if (row === undefined) throw new PlanError(`no ledger row with id ${pyRepr(evalId)}`)
  if (!row.enforcedAt.startsWith(SKILL_ENFORCEMENT)) throw new PlanError(`ledger row ${evalId} is enforced at ${row.enforcedAt}, not by a skill`)
  return row.enforcedAt.slice(SKILL_ENFORCEMENT.length)
}

function configDirFault(configDir: string): string | null {
  const dataDir = env.dataDir()
  if (realpath(configDir) !== realpath(dataDir)) {
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
  const stamp = utcStamp(new Date(), true)
  const rawDir = pyJoin(env.logsDir(), `${RAW_DIR_PREFIX}${plan.evalId}-${stamp}-${randomBytes(2).toString("hex")}`)
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
    if (error instanceof PlanError || error instanceof GitError || isOsError(error)) {
      process.stderr.write(`eval: ${(error as Error).message}\n`)
      return EXIT_USAGE
    }
    throw error
  }
  const { plan, results, leftoverUnknown } = loaded
  if (leftoverUnknown.length > 0) {
    process.stderr.write(`eval: ${rawDir} recorded no leftover project dir check for ${leftoverUnknown.join(", ")}; graded without it\n`)
  }
  const provenance = { regraded_from: pyBasename(pyNormpath(rawDir)), grader }
  return gradeAndWrite(plan, rawDir, results, provenance, { leftover_unknown: leftoverUnknown })
}

function loadRawDir(evalId: string, rawDir: string): { plan: Plan; results: RunResult[]; leftoverUnknown: string[] } {
  const config = readJsonObject(pyJoin(rawDir, "config.json"))
  if (config["eval_id"] !== evalId) throw new PlanError(`${rawDir} holds a ${pyStr(config["eval_id"])} run, not ${evalId}`)
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
  const strays = sortedByCodePoint(new Set(records.map(recordCase).filter((caseId) => !configCases.includes(caseId))))
  const stale = sortedByCodePoint(new Set(records.filter((record) => byId.has(recordCase(record)) && record["kind"] !== byId.get(recordCase(record))?.kind).map(recordCase)))
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
    fullRun, repeat, model: ((pyTruthy(config["model_observed"]) ? config["model_observed"] : config["model_requested"]) as string), command: config["command"] as string[],
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
  const path = pyJoin(rawDir, "runs.jsonl")
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw new PlanError(`no runs.jsonl in ${rawDir}`)
  const { records, malformed: unreadable } = readJsonl(path)
  const malformed = unreadable + records.filter((record) => !RUN_RECORD_KEYS.every((key) => key in record)).length
  if (malformed > 0) throw new PlanError(`${path} has ${malformed} malformed line(s)`)
  if (records.length === 0) throw new PlanError(`${path} holds no run`)
  return records
}

function regradedRun(rawDir: string, regradedCase: Case, record: JsonObject, timeoutSeconds: number): RunResult {
  const stem = pyJoin(rawDir, runName(regradedCase.id, record["run"] as number))
  const streamText = readRawText(stem + ".stream.jsonl")
  const diff = readRawText(stem + ".diff")
  const facts = new RunFacts({
    stream: summarizeStream(pySplitlines(streamText)), exitCode: record["exit"] as number, timedOut: record["timed_out"] as boolean,
    changed: record["changed"] as boolean, leftoverProjectDir: recordedLeftover(record),
  })
  return graded(regradedCase, record["run"] as number, { facts, streamText, diff }, timeoutSeconds)
}

function recordedLeftover(record: JsonObject): string | null {
  if ("leftover_project_dir" in record) return record["leftover_project_dir"] as string | null
  const fault = pyTruthy(record["fault"]) ? (record["fault"] as string) : ""
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
  const stem = pyJoin(rawDir, runName(result.case.id, result.index))
  const facts = result.record.facts
  writeText(stem + ".stream.jsonl", result.record.streamText)
  writeText(stem + ".diff", result.record.diff)
  writeText(stem + ".final.txt", facts.finalText ?? "")
  appendJsonl(pyJoin(rawDir, "runs.jsonl"), {
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
  writeText(pyJoin(rawDir, "config.json"), pythonJsonDumps(config, { sortKeys: true, indent: 2 }) + "\n")
  writeText(pyJoin(rawDir, "skill-diagnostic.json"), pythonJsonDumps(skillDiagnostic(plan, results), { sortKeys: true, indent: 2 }) + "\n")
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
  const path = pyJoin(env.logsDir(), "keel-evals.jsonl")
  const ts = utcStamp(new Date(), false)
  for (const verdict of verdicts) {
    appendJsonl(path, { ts, eval_id: plan.evalId + CASE_SUFFIX, rule_id: plan.evalId, case: verdict.case.id, pass: verdict.passed, model, ...provenance })
  }
  const counts = splits.map((split) => `${split.split}=${split.passedCases}/${split.cases}`).join(" ")
  appendJsonl(path, {
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
  const faults = report["faults"] as PyValue[]
  const verdict = faults.length > 0
    ? `FAULT (${faults.length} run(s)); nothing written`
    : `${report["pass"] ? "PASS" : "FAIL"}; wrote ${report["eval_id"]}`
  process.stderr.write(`eval ${report["rule_id"]}: ${splits} -> ${verdict}; raw: ${rawDir}\n`)
}

function runName(caseId: string, run: number): string {
  return `${caseId}-${run}`
}

function readJsonObject(path: string): JsonObject {
  try {
    const value = pythonJsonLoads(readText(path))
    if (!isJsonObject(value)) throw new ValueError("not an object")
    return value
  } catch (error) {
    if (error instanceof ValueError || isOsError(error)) throw new PlanError(`cannot read ${path}: ${(error as Error).message}`)
    throw error
  }
}

function readRawText(path: string): string {
  try {
    return readText(path)
  } catch (error) {
    if (isOsError(error)) throw new PlanError(`cannot read ${path}: ${(error as Error).message}`)
    throw error
  }
}

function writeText(path: string, text: string): void {
  fs.writeFileSync(path, text, "utf8")
}

runMain(main)
