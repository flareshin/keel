import fs from "node:fs"
import os from "node:os"

import { GitError, runGit } from "../../../lib/measurekit/gitutil.ts"
import { isOsError, ValueError } from "../../../lib/measurekit/pyerrors.ts"
import { readText, UnicodeDecodeError, newlineSeparatedLines } from "../../../lib/measurekit/pyio.ts"
import { pythonJsonDumps, pythonJsonLoads } from "../../../lib/measurekit/pyjson.ts"
import { isDir, pyDirname, pyJoin, realpath } from "../../../lib/measurekit/pypath.ts"
import { firstCodePoints, pySplitlines, pySplitWhitespace } from "../../../lib/measurekit/pystr.ts"
import { isJsonObject, PyFloat, pyRepr, pyStr } from "../../../lib/measurekit/pyvalue.ts"
import type { JsonObject } from "../../../lib/measurekit/pyvalue.ts"
import { projectDirFor } from "./liveconfig.ts"
import { describeLocation } from "./reviewcases.ts"
import type { ReviewCase } from "./reviewcases.ts"
import { CLAUDE_BINARY, NEUTRAL_PROJECT_NAME, projectIdentity, runClaude, UNSIGNED } from "./runner.ts"
import { summarizeStream } from "./stream.ts"

export const WORKFLOW = "lens-review"
const COMPLETED = "completed"
const ERROR_VERDICT = "ERROR"
const MAX_TURNS = 20
const ALLOWED_TOOLS = "Workflow,Skill,Read,Grep,Glob,Bash"
const DENIED_TOOLS = "Edit,Write,NotebookEdit,WebFetch,WebSearch"

export class BuildError extends Error {}

export interface ReviewRun {
  streamText: string
  workflowRecord: JsonObject | null
  exitCode: number
  timedOut: boolean
  repo: string
}

export interface CaseRepo {
  repo: string
  base: string
  head: string
}

export function reviewCommand(model: string): string[] {
  return [
    CLAUDE_BINARY, "-p", "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
    "--allowedTools", ALLOWED_TOOLS, "--disallowedTools", DENIED_TOOLS, "--max-turns", String(MAX_TURNS),
  ]
}

export function reviewPrompt(reviewCase: ReviewCase, repo: string, base: string, head: string): string {
  const workflowArgs: JsonObject = { diffs: [{ repo, base, head }] }
  if (reviewCase.requirement) workflowArgs["requirement"] = reviewCase.requirement
  const lines = [`Run the saved workflow named ${WORKFLOW} with these args (JSON):`, pythonJsonDumps(workflowArgs)]
  if (reviewCase.callerSkill) {
    lines.push(`Before running it, load the skill ${reviewCase.callerSkill} and follow it for this diff: pass the lenses it says fire as args.lenses.`)
  }
  lines.push("I explicitly ask you to run this workflow. Wait until it completes, then reply with the first line of its report. Do not edit any file.")
  return lines.join("\n")
}

export function buildCaseRepo(reviewCase: ReviewCase, parent: string): CaseRepo {
  const repo = pyJoin(parent, NEUTRAL_PROJECT_NAME)
  fs.mkdirSync(pyDirname(repo), { recursive: true })
  if (isDir(reviewCase.baseDir)) fs.cpSync(reviewCase.baseDir, repo, { recursive: true, dereference: true })
  else fs.mkdirSync(repo, { recursive: true })
  const identity = projectIdentity(NEUTRAL_PROJECT_NAME)
  let base: string
  let head: string
  try {
    runGit(repo, ["init", "-q"])
    runGit(repo, ["add", "-A"])
    runGit(repo, [...UNSIGNED, "commit", "-q", "--allow-empty", "-m", "base"], identity)
    runGit(repo, ["apply", "--whitespace=nowarn", reviewCase.changePath])
    runGit(repo, ["add", "-A"])
    runGit(repo, [...UNSIGNED, "commit", "-q", "-m", "change"], identity)
    ;[base, head] = pySplitWhitespace(runGit(repo, ["rev-parse", "HEAD~1", "HEAD"])) as [string, string]
  } catch (error) {
    if (error instanceof GitError) throw new BuildError(`${reviewCase.id}: ${error.message}`)
    throw error
  }
  const missing = reviewCase.locations.filter((location) => !hasLine(repo, location.file, location.line)).map(describeLocation)
  if (missing.length > 0) throw new BuildError(`${reviewCase.id}: no such line after the change: ${missing.join(", ")}`)
  return { repo, base, head }
}

function hasLine(repo: string, relativePath: string, line: number): boolean {
  try {
    return newlineSeparatedLines(readText(pyJoin(repo, relativePath))).length >= line
  } catch (error) {
    if (error instanceof UnicodeDecodeError || isOsError(error)) return false
    throw error
  }
}

export function runReview(reviewCase: ReviewCase, command: string[], configDir: string, timeoutSeconds: number): ReviewRun {
  const parent = realpath(fs.mkdtempSync(pyJoin(os.tmpdir(), "tmp")))
  try {
    const { repo, base, head } = buildCaseRepo(reviewCase, parent)
    const claudeRun = runClaude(command, reviewPrompt(reviewCase, repo, base, head), repo, timeoutSeconds)
    const projectDir = projectDirFor(repo, configDir)
    const sessionId = summarizeStream(pySplitlines(claudeRun.streamText)).init?.["session_id"]
    const record = findWorkflowRecord(projectDir, typeof sessionId === "string" ? sessionId : null)
    fs.rmSync(projectDir, { recursive: true, force: true })
    return { streamText: claudeRun.streamText, workflowRecord: record, exitCode: claudeRun.exitCode, timedOut: claudeRun.timedOut, repo }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

export function findWorkflowRecord(projectDir: string, sessionId: string | null): JsonObject | null {
  if (!sessionId) return null
  const directory = pyJoin(projectDir, sessionId, "workflows")
  let names: string[]
  try {
    names = fs.readdirSync(directory)
  } catch {
    return null
  }
  const records: JsonObject[] = []
  for (const name of names.filter((candidate) => candidate.endsWith(".json") && !candidate.startsWith(".")).sort()) {
    try {
      const record = pythonJsonLoads(readText(pyJoin(directory, name)))
      if (isJsonObject(record) && record["workflowName"] === WORKFLOW) records.push(record)
    } catch (error) {
      if (!(error instanceof ValueError) && !isOsError(error)) throw error
    }
  }
  return records.reduce<JsonObject | null>((latest, record) => (latest === null || startTime(record) > startTime(latest) ? record : latest), null)
}

function startTime(record: JsonObject): number {
  const value = record["startTime"]
  if (typeof value === "number") return value
  if (value instanceof PyFloat) return value.value
  return typeof value === "bigint" ? Number(value) : 0
}

export function runFault(run: ReviewRun, timeoutSeconds: number): string | null {
  if (run.timedOut) return `timed out after ${timeoutSeconds}s`
  const record = run.workflowRecord
  if (record === null) return `no ${WORKFLOW} workflow record for the session (exit ${run.exitCode})`
  if (record["status"] !== COMPLETED) return `${WORKFLOW} workflow status ${pyRepr(record["status"])}`
  const result = record["result"]
  const verdict = isJsonObject(result) ? result["verdict"] : undefined
  if (!isJsonObject(result) || verdict === undefined || verdict === null || verdict === ERROR_VERDICT) {
    const detail = isJsonObject(result) ? result["error"] : result
    return `${WORKFLOW} returned no verdict: ${firstCodePoints(pyStr(detail), 200)}`
  }
  if (!Array.isArray(result["blocking"])) return `${WORKFLOW} result has no blocking list`
  return null
}
