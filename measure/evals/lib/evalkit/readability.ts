import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runGitOrThrow } from "../../../lib/measurekit/gitutil.ts"
import { runProcess } from "../../../lib/measurekit/subprocess.ts"
import { NEUTRAL_PROJECT_NAME, UNSIGNED, projectIdentity } from "./runner.ts"

const RULE_CHECKS = path.join("skills", "writing-readable-code", "scripts", "rule-checks.ts")
const SIGNAL_PREFIX = "signal "

export type RuleCheck = { signals: string[] } | { fault: string }

export function ruleCheckDiff(graderCheckout: string, fixture: string, diff: string): RuleCheck {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"))
  const work = path.join(parent, NEUTRAL_PROJECT_NAME)
  try {
    fs.cpSync(fixture, work, { recursive: true, dereference: true })
    runGitOrThrow(work, ["init", "-q"])
    commitAll(work, "init")
    if (diff.trim() !== "") runGitOrThrow(work, ["apply", "--index", "-"], {}, diff)
    commitAll(work, "change")
    const command = [process.execPath, path.join(graderCheckout, RULE_CHECKS), "--repo", work, "--base", "HEAD~1", "--head", "HEAD"]
    const completed = runProcess(command)
    if (completed.returncode !== 0) return { fault: `rule-checks exit ${completed.returncode}: ${lastLine(completed.stdout + completed.stderr)}` }
    return { signals: completed.stdout.split("\n").filter((line) => line.startsWith(SIGNAL_PREFIX)) }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

function commitAll(work: string, message: string): void {
  runGitOrThrow(work, ["add", "-A"])
  runGitOrThrow(work, [...UNSIGNED, "commit", "-q", "--allow-empty", "-m", message], projectIdentity(NEUTRAL_PROJECT_NAME))
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? ""
}
