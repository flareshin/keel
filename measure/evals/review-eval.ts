#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  choiceOption, EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, flagOption, noPositionals, parseCommandLine, positiveIntOption, printJson, runMain,
  stringOption, usageError,
} from "../lib/measurekit/cli.ts"
import type { CommandSpec } from "../lib/measurekit/cli.ts"
import { appendJsonl, readJsonl } from "../lib/measurekit/datafiles.ts"
import { compactUtcSeconds, utcSeconds } from "../lib/measurekit/dates.ts"
import * as env from "../lib/measurekit/env.ts"
import { isFile, readUtf8 } from "../lib/measurekit/files.ts"
import { displayText, isJsonObject, parseJson, stringifySorted } from "../lib/measurekit/json.ts"
import type { JsonObject } from "../lib/measurekit/json.ts"
import { CaseError, SPLITS } from "./lib/evalkit/cases.ts"
import { cliConfigDir } from "./lib/evalkit/liveconfig.ts"
import { loadReviewCases, selectReviewCases } from "./lib/evalkit/reviewcases.ts"
import type { ReviewCase } from "./lib/evalkit/reviewcases.ts"
import { gradeResult, suiteNumbers } from "./lib/evalkit/reviewgrade.ts"
import type { RunGrade, SplitNumbers, SuiteNumbers } from "./lib/evalkit/reviewgrade.ts"
import { BuildError, buildCaseRepo, reviewCommand, runFault, runReview } from "./lib/evalkit/reviewrun.ts"
import type { ReviewRun } from "./lib/evalkit/reviewrun.ts"
import { CLAUDE_BINARY, findOnPath } from "./lib/evalkit/runner.ts"

const DEFAULT_REPEAT = 3
const DEFAULT_MODEL = "sonnet"
const DEFAULT_TIMEOUT_SECONDS = 1800
const RAW_DIR_PREFIX = "keel-review-eval-"
const SUMMARY_LOG = "keel-review-eval.jsonl"
const REVIEWER_FILES = ["lens-review.js", "adversarial-audit.js"]
const JSON_INDENT = 2
const COMMAND: CommandSpec = {
  prog: "measure/evals/review-eval",
  usage: "measure/evals/review-eval [-h] [--split {train,holdout}] [--case CASE] [--repeat N] [--model MODEL] [--timeout-seconds S] [--dry-run] [--regrade RAW_DIR]",
  description: "Score the lens-review reviewer on known incidents and clean diffs.",
  argumentHelp: [
    ["--split {train,holdout}", "run one split only"],
    ["--case CASE", "run one case only"],
    ["--repeat N", `reviews per case (default ${DEFAULT_REPEAT})`],
    ["--model MODEL", `model of the session that starts the workflow (default ${DEFAULT_MODEL}); the reviewer agents use lens-review's own`],
    ["--timeout-seconds S", `per-review limit (default ${DEFAULT_TIMEOUT_SECONDS})`],
    ["--dry-run", "build every case repo and print the plan; run nothing"],
    ["--regrade RAW_DIR", "grade an earlier run's saved workflow records again; calls no claude"],
  ],
  options: {
    split: { type: "string" }, case: { type: "string" }, repeat: { type: "string" }, model: { type: "string" },
    "timeout-seconds": { type: "string" }, "dry-run": { type: "boolean" }, regrade: { type: "string" },
  },
}

interface ReviewEvalArgs {
  split: string | undefined
  caseId: string | undefined
  repeat: number
  model: string
  timeoutSeconds: number
  dryRun: boolean
  regrade: string | undefined
}

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
  const args = parseReviewEvalArgs(argv)
  let cases: ReviewCase[]
  try {
    cases = selectReviewCases(loadReviewCases([env.keelHome(), env.overlayDir()]), args.split, args.caseId)
  } catch (error) {
    if (!(error instanceof CaseError)) throw error
    process.stderr.write(`review-eval: ${error.message}\n`)
    return EXIT_USAGE
  }
  if (args.regrade) return regrade(args.regrade, cases)
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
  if (args.dryRun) {
    printJson(config)
    return EXIT_OK
  }
  const rawDir = createRawDir(config)
  const { grades, faults } = runAll(cases, config, rawDir)
  const report = buildReport(config, grades, faults, rawDir)
  if (faults.length === 0 && config.full_run) appendJsonl(path.join(env.logsDir(), SUMMARY_LOG), summaryLine(report))
  printJson(report)
  printSummary(report)
  return faults.length > 0 ? EXIT_NEGATIVE : EXIT_OK
}

function parseReviewEvalArgs(argv: string[]): ReviewEvalArgs {
  const parsed = parseCommandLine(COMMAND, argv)
  noPositionals(COMMAND, parsed)
  const args: ReviewEvalArgs = {
    split: choiceOption(COMMAND, "--split", stringOption(parsed, "split"), SPLITS),
    caseId: stringOption(parsed, "case"),
    repeat: positiveIntOption(COMMAND, "--repeat", stringOption(parsed, "repeat"), DEFAULT_REPEAT),
    model: stringOption(parsed, "model") ?? DEFAULT_MODEL,
    timeoutSeconds: positiveIntOption(COMMAND, "--timeout-seconds", stringOption(parsed, "timeout-seconds"), DEFAULT_TIMEOUT_SECONDS),
    dryRun: flagOption(parsed, "dry-run"),
    regrade: stringOption(parsed, "regrade"),
  }
  if (args.regrade && (args.split || args.caseId || args.dryRun)) {
    usageError(COMMAND, "--regrade takes its cases from the raw dir; drop --split, --case and --dry-run")
  }
  return args
}

function planProblem(cases: ReviewCase[]): string | null {
  if (cases.length === 0) return "no case selected"
  if (findOnPath(CLAUDE_BINARY) === null) return `no \`${CLAUDE_BINARY}\` on PATH`
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"))
  try {
    for (const planned of cases) buildCaseRepo(planned, path.join(parent, planned.id))
  } catch (error) {
    if (error instanceof BuildError) return error.message
    throw error
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
  return null
}

function runConfig(args: ReviewEvalArgs, cases: ReviewCase[]): RunConfig {
  const configDir = cliConfigDir()
  const model = args.model
  return {
    full_run: args.split === undefined && args.caseId === undefined,
    repeat: args.repeat, model, timeout_seconds: args.timeoutSeconds, config_dir: configDir,
    command: reviewCommand(model), reviewer: reviewerFingerprint(configDir),
    cases: cases.map((planned) => ({ id: planned.id, split: planned.split, clean: planned.isClean })),
  }
}

function reviewerFingerprint(configDir: string): { [file: string]: string | null } {
  const fingerprint: { [file: string]: string | null } = {}
  for (const name of REVIEWER_FILES) {
    const workflowPath = path.join(configDir, "workflows", name)
    fingerprint[name] = isFile(workflowPath) ? createHash("sha256").update(fs.readFileSync(workflowPath)).digest("hex") : null
  }
  return fingerprint
}

function createRawDir(config: RunConfig): string {
  const rawDir = path.join(env.logsDir(), `${RAW_DIR_PREFIX}${compactUtcSeconds(new Date())}-${randomBytes(2).toString("hex")}`)
  fs.mkdirSync(rawDir, { recursive: true })
  writeJson(path.join(rawDir, "config.json"), config)
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
  const stem = path.join(rawDir, `${reviewed.id}-${index}`)
  fs.writeFileSync(stem + ".stream.jsonl", run.streamText, "utf8")
  if (run.workflowRecord !== null) writeJson(stem + ".workflow.json", run.workflowRecord)
  appendJsonl(path.join(rawDir, "runs.jsonl"), {
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
  return { ts: utcSeconds(new Date()), reviewer: report.reviewer, repeat: report.repeat, numbers: report.numbers, raw_dir: path.basename(report.raw_dir) }
}

function floatText(value: number | null): string {
  return value === null ? "none" : String(value)
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
  const { records, malformed } = readJsonl(path.join(rawDir, "runs.jsonl"))
  if (malformed > 0 || records.length === 0) {
    process.stderr.write(`review-eval: ${rawDir}/runs.jsonl is missing, empty or malformed\n`)
    return EXIT_USAGE
  }
  const unknown = [...new Set(records.map((record) => record["case"] as string).filter((caseId) => !byId.has(caseId)))].sort()
  if (unknown.length > 0) {
    process.stderr.write(`review-eval: case(s) ${unknown.join(", ")} are no longer in the case files\n`)
    return EXIT_USAGE
  }
  const graded = records.filter((record) => !record["fault"]).map((record) => ({ record, grade: regraded(rawDir, byId.get(record["case"] as string) as ReviewCase, record) }))
  const same = graded.filter(({ record, grade }) => record["hit"] === grade.hit && record["blocking"] === grade.blocking).length
  printJson({
    regraded_from: path.basename(path.normalize(rawDir)), runs: graded.length, same_grade: same,
    numbers: suiteNumbers(graded.map(({ grade }) => grade)),
  })
  process.stderr.write(`review-eval: regrade ${same}/${graded.length} runs graded the same\n`)
  return same === graded.length ? EXIT_OK : EXIT_NEGATIVE
}

function regraded(rawDir: string, reviewed: ReviewCase, record: JsonObject): RunGrade {
  const workflow = parseJson(readUtf8(path.join(rawDir, `${reviewed.id}-${record["run"]}.workflow.json`)))
  if (!isJsonObject(workflow)) throw new TypeError(`workflow record of ${reviewed.id} is not an object: ${displayText(workflow)}`)
  return gradeResult(reviewed, record["run"] as number, workflow["result"])
}

function writeJson(file: string, value: object): void {
  fs.writeFileSync(file, stringifySorted(value, JSON_INDENT) + "\n", "utf8")
}

runMain(main)
