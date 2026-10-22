import fs from "node:fs"
import os from "node:os"

import { runGit } from "../../../lib/measurekit/gitutil.ts"
import { isDir, pyJoin } from "../../../lib/measurekit/pypath.ts"
import { compilePythonRegex } from "../../../lib/measurekit/pyregex.ts"
import { readText, UnicodeDecodeError } from "../../../lib/measurekit/pyio.ts"
import { isOsError } from "../../../lib/measurekit/pyerrors.ts"
import { pySplitlines, pyStrip } from "../../../lib/measurekit/pystr.ts"
import { runProcess, TimeoutExpired } from "../../../lib/measurekit/subprocess.ts"
import { QUESTION_MARKER } from "./grade.ts"
import { projectDirFor } from "./liveconfig.ts"
import { RunFacts, summarizeStream } from "./stream.ts"

export const CLAUDE_BINARY = "claude"
const MAX_TURNS = 8
const ALLOWED_TOOLS = "Skill,Read,Grep,Glob,Edit,Write,AskUserQuestion"
const DENIED_TOOLS = "Bash,NotebookEdit,Agent,Task,Workflow,WebFetch,WebSearch"
const TIMEOUT_EXIT = 124
export const UNSIGNED = ["-c", "commit.gpgsign=false"]
export const NEUTRAL_PROJECT_NAME = "app"
const HARNESS_WORDS = ["eval", "test", "judge", "fixture", "keel", "candidate"]
const README_TITLE = compilePythonRegex("^#[ \\t]+(.+)$", "m")
const NON_SLUG_CHARS = compilePythonRegex("[^a-z0-9]+", "g")
const OUTSIDE_FIXTURE = [".", ":!.claude"]
export const QUESTION_PROTOCOL =
  "This session is non-interactive and the AskUserQuestion tool is unavailable. To ask the user something, " +
  `write each question on its own line starting with "${QUESTION_MARKER}".`

export interface RunRecord {
  facts: RunFacts
  streamText: string
  diff: string
}

export interface ClaudeRun {
  exitCode: number
  timedOut: boolean
  streamText: string
}

export function claudeCommand(model: string): string[] {
  return [
    CLAUDE_BINARY, "-p", "--model", model, "--output-format", "stream-json", "--verbose",
    "--settings", '{"disableAllHooks":true}',
    "--tools", ALLOWED_TOOLS, "--disallowedTools", DENIED_TOOLS,
    "--permission-mode", "acceptEdits", "--strict-mcp-config",
    "--max-turns", String(MAX_TURNS), "--no-session-persistence", "--append-system-prompt", QUESTION_PROTOCOL,
  ]
}

export function runOnce(prompt: string, fixture: string, command: string[], configDir: string, timeoutSeconds: number): RunRecord {
  const project = resolveProjectName(fixture)
  const parent = fs.mkdtempSync(pyJoin(os.tmpdir(), "tmp"))
  const work = pyJoin(parent, project)
  try {
    prepareFixtureRepo(fixture, work, project)
    const claudeRun = runClaude(command, prompt, work, timeoutSeconds)
    const changed = pyStrip(runGit(work, ["status", "--porcelain", "--", ...OUTSIDE_FIXTURE])) !== ""
    const leftover = projectDirFor(work, configDir)
    const facts = new RunFacts({
      stream: summarizeStream(pySplitlines(claudeRun.streamText)), exitCode: claudeRun.exitCode, timedOut: claudeRun.timedOut,
      changed, leftoverProjectDir: isDir(leftover) ? leftover : null,
    })
    return { facts, streamText: claudeRun.streamText, diff: diffOfChanges(work) }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

export function resolveProjectName(fixture: string): string {
  const slug = readmeTitle(fixture).toLowerCase().replace(NON_SLUG_CHARS, "-").replace(/^-+|-+$/g, "")
  if (!slug || HARNESS_WORDS.some((word) => slug.includes(word))) return NEUTRAL_PROJECT_NAME
  return slug
}

function readmeTitle(fixture: string): string {
  try {
    const match = README_TITLE.exec(readText(pyJoin(fixture, "README.md")))
    return match ? (match[1] as string) : ""
  } catch (error) {
    if (error instanceof UnicodeDecodeError || isOsError(error)) return ""
    throw error
  }
}

function prepareFixtureRepo(fixture: string, work: string, project: string): void {
  fs.cpSync(fixture, work, { recursive: true, dereference: true })
  runGit(work, ["init", "-q"])
  runGit(work, ["add", "-A"])
  runGit(work, [...UNSIGNED, "commit", "-q", "-m", "init"], projectIdentity(project))
}

export function projectIdentity(project: string): Record<string, string> {
  const email = `dev@${project}.invalid`
  return { GIT_AUTHOR_NAME: project, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: project, GIT_COMMITTER_EMAIL: email }
}

export function runClaude(command: string[], prompt: string, cwd: string, timeoutSeconds: number): ClaudeRun {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
  try {
    const completed = runProcess(command, { input: prompt + "\n", cwd, env, timeoutSeconds })
    return { exitCode: completed.returncode, timedOut: false, streamText: completed.stdout }
  } catch (error) {
    if (error instanceof TimeoutExpired) return { exitCode: TIMEOUT_EXIT, timedOut: true, streamText: error.partialStdout }
    throw error
  }
}

function diffOfChanges(work: string): string {
  runGit(work, ["add", "-A", "--", ...OUTSIDE_FIXTURE])
  return runGit(work, ["diff", "--cached"])
}
