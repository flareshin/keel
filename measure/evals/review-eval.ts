#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"

import { ArgumentParser, positiveInt } from "../lib/measurekit/argparse.ts"
import type { ParsedArguments } from "../lib/measurekit/argparse.ts"
import { EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, printJson, runMain } from "../lib/measurekit/cli.ts"
import { appendJsonl, readJsonl } from "../lib/measurekit/datafiles.ts"
import * as env from "../lib/measurekit/env.ts"
import { utcStamp } from "../lib/measurekit/pydate.ts"
import { readText } from "../lib/measurekit/pyio.ts"
import { pythonJsonDumps, pythonJsonLoads } from "../lib/measurekit/pyjson.ts"
import { isFile, pyBasename, pyJoin, pyNormpath, which } from "../lib/measurekit/pypath.ts"
import { sortedByCodePoint } from "../lib/measurekit/pystr.ts"
import { isJsonObject, pyFloatRepr, pyStr } from "../lib/measurekit/pyvalue.ts"
import type { JsonObject, PyFloat } from "../lib/measurekit/pyvalue.ts"
import { CaseError, SPLITS } from "./lib/evalkit/cases.ts"
import { cliConfigDir } from "./lib/evalkit/liveconfig.ts"
import { loadReviewCases, selectReviewCases } from "./lib/evalkit/reviewcases.ts"
import type { ReviewCase } from "./lib/evalkit/reviewcases.ts"
import { gradeResult, suiteNumbers } from "./lib/evalkit/reviewgrade.ts"
import type { RunGrade, SplitNumbers, SuiteNumbers } from "./lib/evalkit/reviewgrade.ts"
import { BuildError, buildCaseRepo, reviewCommand, runFault, runReview } from "./lib/evalkit/reviewrun.ts"
import type { ReviewRun } from "./lib/evalkit/reviewrun.ts"
import { CLAUDE_BINARY } from "./lib/evalkit/runner.ts"

const DEFAULT_REPEAT = 3
const DEFAULT_MODEL = "sonnet"
const DEFAULT_TIMEOUT_SECONDS = 1800
const RAW_DIR_PREFIX = "keel-review-eval-"
const SUMMARY_LOG = "keel-review-eval.jsonl"
const REVIEWER_FILES = ["lens-review.js", "adversarial-audit.js"]

interface RunConfig {
  full_run: boolean
  repeat: number
  model: string
  timeout_seconds: number
  config_dir: string
  command: string[]
  reviewer: { [file: string]: string | null }
  cases: { id: string; split: string; clean: boolean }[]
}

interface Fault {
  case: string
  run: number
  reason: string
}

function main(argv: string[]): number {
  const args = parseArgs(argv)
  let cases: ReviewCase[]
  try {
    cases = selectReviewCases(loadReviewCases([env.keelHome(), env.overlayDir()]), args["split"] as string | undefined, args["case"] as string | undefined)
  } catch (error) {
    if (!(error instanceof CaseError)) throw error
    process.stderr.write(`review-eval: ${error.message}\n`)
    return EXIT_USAGE
  }
  if (args["regrade"]) return regrade(args["regrade"] as string, cases)
  const problem = planProblem(cases)
  if (problem) {
    process.stderr.write(`review-eval: ${problem}\n`)
    return EXIT_USAGE
  }
  const config = runConfig(args, cases)
  const perSplit = SPLITS.map((split) => `${split} ${cases.filter((candidate) => candidate.split === split).length}`).join(", ")
  process.stderr.write(
    `review-eval: ${cases.length} cases (${perSplit}) x ${config.repeat} = ${cases.length * config.repeat} reviews, driver model ${config.model}\n`,
  )
  if (args["dry_run"] === true) {
    printJson(config)
    return EXIT_OK
  }
  const rawDir = createRawDir(config)
  const { grades, faults } = runAll(cases, config, rawDir)
  const report = buildReport(config, grades, faults, rawDir)
  if (faults.length === 0 && config.full_run) appendJsonl(pyJoin(env.logsDir(), SUMMARY_LOG), summaryLine(report))
  printJson(report)
  printSummary(report)
  return faults.length > 0 ? EXIT_NEGATIVE : EXIT_OK
}

function parseArgs(argv: string[]): ParsedArguments {
  const parser = new ArgumentParser({
    prog: "measure/evals/review-eval",
    description: "Score the lens-review reviewer on known incidents and clean diffs.",
    arguments: [
      { flags: ["--split"], dest: "split", kind: "value", choices: SPLITS, help: "run one split only" },
      { flags: ["--case"], dest: "case", kind: "value", help: "run one case only" },
      { flags: ["--repeat"], dest: "repeat", kind: "value", convert: positiveInt, typeName: "positive_int", defaultValue: DEFAULT_REPEAT, help: `reviews per case (default ${DEFAULT_REPEAT})` },
      {
        flags: ["--model"], dest: "model", kind: "value", defaultValue: DEFAULT_MODEL,
        help: `model of the session that starts the workflow (default ${DEFAULT_MODEL}); the reviewer agents use lens-review's own`,
      },
      { flags: ["--timeout-seconds"], dest: "timeout_seconds", kind: "value", convert: positiveInt, typeName: "positive_int", defaultValue: DEFAULT_TIMEOUT_SECONDS, help: `per-review limit (default ${DEFAULT_TIMEOUT_SECONDS})` },
      { flags: ["--dry-run"], dest: "dry_run", kind: "flag", help: "build every case repo and print the plan; run nothing" },
      { flags: ["--regrade"], dest: "regrade", kind: "value", metavar: "RAW_DIR", help: "grade an earlier run's saved workflow records again; calls no claude" },
    ],
  })
  const args = parser.parse(argv)
  if (args["regrade"] && (args["split"] || args["case"] || args["dry_run"])) {
    parser.error("--regrade takes its cases from the raw dir; drop --split, --case and --dry-run")
  }
  return args
}

function planProblem(cases: ReviewCase[]): string | null {
  if (cases.length === 0) return "no case selected"
  if (which(CLAUDE_BINARY) === null) return `no \`${CLAUDE_BINARY}\` on PATH`
  const parent = fs.mkdtempSync(pyJoin(os.tmpdir(), "tmp"))
  try {
    for (const planned of cases) buildCaseRepo(planned, pyJoin(parent, planned.id))
  } catch (error) {
    if (error instanceof BuildError) return error.message
    throw error
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
  return null
}

function runConfig(args: ParsedArguments, cases: ReviewCase[]): RunConfig {
  const configDir = cliConfigDir()
  const model = args["model"] as string
  return {
    full_run: args["split"] === undefined && args["case"] === undefined,
    repeat: args["repeat"] as number, model, timeout_seconds: args["timeout_seconds"] as number, config_dir: configDir,
    command: reviewCommand(model), reviewer: reviewerFingerprint(configDir),
    cases: cases.map((planned) => ({ id: planned.id, split: planned.split, clean: planned.isClean })),
  }
}

function reviewerFingerprint(configDir: string): { [file: string]: string | null } {
  const fingerprint: { [file: string]: string | null } = {}
  for (const name of REVIEWER_FILES) {
    const path = pyJoin(configDir, "workflows", name)
    fingerprint[name] = isFile(path) ? createHash("sha256").update(fs.readFileSync(path)).digest("hex") : null
  }
  return fingerprint
}

function createRawDir(config: RunConfig): string {
  const rawDir = pyJoin(env.logsDir(), `${RAW_DIR_PREFIX}${utcStamp(new Date(), true)}-${randomBytes(2).toString("hex")}`)
  fs.mkdirSync(rawDir, { recursive: true })
  writeJson(pyJoin(rawDir, "config.json"), config)
  return rawDir
}

function runAll(cases: ReviewCase[], config: RunConfig, rawDir: string): { grades: RunGrade[]; faults: Fault[] } {
  const grades: RunGrade[] = []
  const faults: Fault[] = []
  for (const planned of cases) {
    for (let index = 1; index <= config.repeat; index++) {
      const run = runReview(planned, config.command, config.config_dir, config.timeout_seconds)
      const fault = runFault(run, config.timeout_seconds)
      const record = run.workflowRecord
      const grade = fault === null && record !== null ? gradeResult(planned, index, record["result"]) : null
      saveRun(rawDir, planned, index, run, fault, grade)
      if (fault !== null) faults.push({ case: planned.id, run: index, reason: fault })
      else if (grade !== null) grades.push(grade)
      const outcome = fault !== null ? "FAULT " + fault : describe(grade as RunGrade)
      process.stderr.write(`  ${planned.id} ${index}/${config.repeat}: ${outcome}\n`)
    }
  }
  return { grades, faults }
}

function describe(grade: RunGrade): string {
  if (grade.case.isClean) return `clean, ${grade.blocking} blocking`
  return `${grade.hit ? "hit" : "miss"}, ${grade.blocking} blocking`
}

function saveRun(rawDir: string, reviewed: ReviewCase, index: number, run: ReviewRun, fault: string | null, grade: RunGrade | null): void {
  const stem = pyJoin(rawDir, `${reviewed.id}-${index}`)
  fs.writeFileSync(stem + ".stream.jsonl", run.streamText, "utf8")
  if (run.workflowRecord !== null) writeJson(stem + ".workflow.json", run.workflowRecord)
  appendJsonl(pyJoin(rawDir, "runs.jsonl"), {
    case: reviewed.id, run: index, exit: run.exitCode, timed_out: run.timedOut, fault,
    blocking: grade ? grade.blocking : null, hit: grade ? grade.hit : null, pass: grade ? grade.passed : null,
  })
}

interface Report {
  full_run: boolean
  repeat: number
  reviewer: RunConfig["reviewer"]
  raw_dir: string
  numbers: SuiteNumbers
  faults: Fault[]
  cases: { id: string; split: string; clean: boolean; runs: { run: number; pass: boolean; blocking: number }[] }[]
}

function buildReport(config: RunConfig, grades: RunGrade[], faults: Fault[], rawDir: string): Report {
  return {
    full_run: config.full_run, repeat: config.repeat, reviewer: config.reviewer, raw_dir: rawDir,
    numbers: suiteNumbers(grades), faults,
    cases: config.cases.map((planned) => ({
      id: planned.id, split: planned.split, clean: planned.clean,
      runs: grades.filter((grade) => grade.case.id === planned.id).map((grade) => ({ run: grade.run, pass: grade.passed, blocking: grade.blocking })),
    })),
  }
}

function summaryLine(report: Report): object {
  return { ts: utcStamp(new Date(), false), reviewer: report.reviewer, repeat: report.repeat, numbers: report.numbers, raw_dir: pyBasename(report.raw_dir) }
}

function floatText(value: PyFloat | null): string {
  return value === null ? "None" : pyFloatRepr(value.value)
}

function printSummary(report: Report): void {
  const numbers = report.numbers
  for (const split of SPLITS) {
    const part: SplitNumbers = numbers[split as "train" | "holdout"]
    process.stderr.write(
      `review-eval ${split}: recall ${floatText(part.recall)} (${part.hits}/${part.defect_runs}), noise ${floatText(part.noise_rate)} ` +
      `(${part.noisy_runs}/${part.clean_runs} clean runs), recall stdev ${floatText(part.recall_stdev)}\n`,
    )
  }
    process.stderr.write(
    `review-eval: case agreement ${floatText(numbers.case_agreement)}, headroom ${numbers.headroom ? "yes" : "none (train recall 1.0, noise 0)"}, ` +
    `faults ${report.faults.length}; raw: ${report.raw_dir}\n`,
  )
}

function regrade(rawDir: string, cases: ReviewCase[]): number {
  const byId = new Map(cases.map((planned) => [planned.id, planned]))
  const { records, malformed } = readJsonl(pyJoin(rawDir, "runs.jsonl"))
  if (malformed > 0 || records.length === 0) {
    process.stderr.write(`review-eval: ${rawDir}/runs.jsonl is missing, empty or malformed\n`)
    return EXIT_USAGE
  }
  const unknown = sortedByCodePoint(new Set(records.map((record) => record["case"] as string).filter((caseId) => !byId.has(caseId))))
  if (unknown.length > 0) {
    process.stderr.write(`review-eval: case(s) ${unknown.join(", ")} are no longer in the case files\n`)
    return EXIT_USAGE
  }
  const graded = records.filter((record) => !record["fault"]).map((record) => ({ record, grade: regraded(rawDir, byId.get(record["case"] as string) as ReviewCase, record) }))
  const same = graded.filter(({ record, grade }) => record["hit"] === grade.hit && record["blocking"] === grade.blocking).length
  printJson({
    regraded_from: pyBasename(pyNormpath(rawDir)), runs: graded.length, same_grade: same,
    numbers: suiteNumbers(graded.map(({ grade }) => grade)),
  })
  process.stderr.write(`review-eval: regrade ${same}/${graded.length} runs graded the same\n`)
  return same === graded.length ? EXIT_OK : EXIT_NEGATIVE
}

function regraded(rawDir: string, reviewed: ReviewCase, record: JsonObject): RunGrade {
  const workflow = pythonJsonLoads(readText(pyJoin(rawDir, `${reviewed.id}-${record["run"]}.workflow.json`)))
  if (!isJsonObject(workflow)) throw new TypeError(`workflow record of ${reviewed.id} is not an object: ${pyStr(workflow)}`)
  return gradeResult(reviewed, record["run"] as number, workflow["result"])
}

function writeJson(path: string, value: object): void {
  fs.writeFileSync(path, pythonJsonDumps(value as JsonObject, { sortKeys: true, indent: 2 }) + "\n", "utf8")
}

runMain(main)
