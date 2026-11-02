import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { GitError, runGitOrThrow } from "../../../lib/measurekit/gitutil.ts"
import { runProcess } from "../../../lib/measurekit/subprocess.ts"
import { NEUTRAL_PROJECT_NAME, UNSIGNED, projectIdentity } from "./runner.ts"

const RULE_CHECKS = path.join("skills", "writing-readable-code", "scripts", "rule-checks.ts")
const EVAL_GRADER = "grade.ts"
const SIGNAL_PREFIX = "signal "
const SUMMARY_PREFIX = "summary "
const ERROR_LINE = /^\w*Error\b/

export type RuleCheck = { signals: string[] } | { fault: string }

export function ruleCheckDiff(graderCheckout: string, fixture: string, diff: string): RuleCheck {
  return checkDiff(path.join(graderCheckout, RULE_CHECKS), "rule-checks", fixture, diff)
}

export function evalGraderDiff(graderCheckout: string, evalId: string, fixture: string, diff: string): RuleCheck {
  return checkDiff(path.join(graderCheckout, "measure", "evals", evalId, EVAL_GRADER), `${evalId} grader`, fixture, diff)
}

function checkDiff(script: string, label: string, fixture: string, diff: string): RuleCheck {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"))
  const work = path.join(parent, NEUTRAL_PROJECT_NAME)
  try {
    fs.cpSync(fixture, work, { recursive: true, dereference: true })
    runGitOrThrow(work, ["init", "-q"])
    commitAll(work, "init")
    if (diff.trim() !== "") runGitOrThrow(work, ["apply", "--index", "-"], {}, diff)
    commitAll(work, "change")
    const command = [process.execPath, script, "--repo", work, "--base", "HEAD~1", "--head", "HEAD"]
    const completed = runProcess(command)
    if (completed.returncode !== 0) return { fault: `${label} exit ${completed.returncode}: ${failureReason(completed.stdout, completed.stderr)}` }
    return { signals: completed.stdout.split("\n").filter((line) => line.startsWith(SIGNAL_PREFIX)) }
  } catch (error) {
    if (error instanceof GitError) return { fault: `${label} could not rebuild the diff: ${error.message}` }
    throw error
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

function commitAll(work: string, message: string): void {
  runGitOrThrow(work, ["add", "-A"])
  runGitOrThrow(work, [...UNSIGNED, "commit", "-q", "--allow-empty", "-m", message], projectIdentity(NEUTRAL_PROJECT_NAME))
}

function failureReason(stdout: string, stderr: string): string {
  const summary = stdout.split("\n").find((line) => line.startsWith(SUMMARY_PREFIX))
  if (summary !== undefined) return summary
  const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  return lines.find((line) => ERROR_LINE.test(line)) ?? lines[0] ?? ""
}
