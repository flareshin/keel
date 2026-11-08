import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { InvalidUtf8Error, isDir, isExecutable, isSystemError, readUtf8, splitLines, walkEntries } from "../../../lib/measurekit/files.ts"
import { runGitOrThrow } from "../../../lib/measurekit/gitutil.ts"
import { runProcess } from "../../../lib/measurekit/subprocess.ts"
import { TimeoutExpired } from "../../../lib/measurekit/timeout.ts"
import { QUESTION_MARKER } from "./grade.ts"
import { projectDirFor } from "./liveconfig.ts"
import { RunFacts, summarizeStream } from "./stream.ts"

export const CLAUDE_BINARY = "claude"
export const DEFAULT_MAX_TURNS = 8
const SUBAGENT_META_FILE = /^[^/]+\/subagents\/agent-[^/]+\.meta\.json$/
const ALLOWED_TOOLS = ["Skill", "Read", "Grep", "Glob", "Edit", "Write", "AskUserQuestion"]
const DENIED_TOOLS = ["Bash", "NotebookEdit", "Agent", "Task", "Workflow", "WebFetch", "WebSearch"]
const DENIED_NAMES_OF_UNLOCKABLE_TOOL: Record<string, string[]> = { Agent: ["Agent", "Task"] }
export const UNLOCKABLE_TOOLS = Object.keys(DENIED_NAMES_OF_UNLOCKABLE_TOOL)
const TIMEOUT_EXIT = 124
export const UNSIGNED = ["-c", "commit.gpgsign=false"]
export const NEUTRAL_PROJECT_NAME = "app"
const HARNESS_WORDS = ["eval", "test", "judge", "fixture", "keel", "candidate"]
const README_TITLE = /^#[ \t]+(.+)$/m
const NON_SLUG_CHARS = /[^a-z0-9]+/g
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

export function claudeCommand(model: string, unlockedTools: string[] = [], maxTurns = DEFAULT_MAX_TURNS): string[] {
  const unlockedNames = unlockedTools.flatMap((tool) => DENIED_NAMES_OF_UNLOCKABLE_TOOL[tool] ?? [])
  const tools = [...ALLOWED_TOOLS, ...unlockedTools]
  const denied = DENIED_TOOLS.filter((tool) => !unlockedNames.includes(tool))
  return [
    CLAUDE_BINARY, "-p", "--model", model, "--output-format", "stream-json", "--verbose",
    "--settings", '{"disableAllHooks":true}',
    "--tools", tools.join(","), "--disallowedTools", denied.join(","),
    "--permission-mode", "acceptEdits", "--strict-mcp-config",
    "--max-turns", String(maxTurns), "--no-session-persistence", "--append-system-prompt", QUESTION_PROTOCOL,
  ]
}

export function runOnce(prompt: string, fixture: string, command: string[], configDir: string, timeoutSeconds: number): RunRecord {
  const project = resolveProjectName(fixture)
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"))
  const work = path.join(parent, project)
  try {
    prepareFixtureRepo(fixture, work, project)
    const claudeRun = runClaude(command, prompt, work, timeoutSeconds)
    const changed = runGitOrThrow(work, ["status", "--porcelain", "--", ...OUTSIDE_FIXTURE]).trim() !== ""
    const facts = new RunFacts({
      stream: summarizeStream(splitLines(claudeRun.streamText)), exitCode: claudeRun.exitCode, timedOut: claudeRun.timedOut,
      changed, leftoverProjectDir: leftoverProjectDir(work, configDir),
    })
    return { facts, streamText: claudeRun.streamText, diff: diffOfChanges(work) }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

function leftoverProjectDir(work: string, configDir: string): string | null {
  const projectDir = projectDirFor(work, configDir)
  if (!isDir(projectDir)) return null
  if (!holdsOnlySubagentMetaFiles(projectDir)) return projectDir
  fs.rmSync(projectDir, { recursive: true, force: true })
  return null
}

function holdsOnlySubagentMetaFiles(projectDir: string): boolean {
  const relativePaths = walkEntries(projectDir).filter((entry) => !isDir(entry)).map((entry) => path.relative(projectDir, entry))
  return relativePaths.length > 0 && relativePaths.every((relativePath) => SUBAGENT_META_FILE.test(relativePath))
}

export function findOnPath(command: string): string | null {
  const directories = (process.env["PATH"] ?? "").split(path.delimiter)
  const candidates = command.includes("/") ? [command] : directories.map((directory) => path.join(directory || ".", command))
  return candidates.find((candidate) => isExecutable(candidate) && !isDir(candidate)) ?? null
}

export function resolveProjectName(fixture: string): string {
  const slug = readmeTitle(fixture).toLowerCase().replace(NON_SLUG_CHARS, "-").replace(/^-+|-+$/g, "")
  if (!slug || HARNESS_WORDS.some((word) => slug.includes(word))) return NEUTRAL_PROJECT_NAME
  return slug
}

function readmeTitle(fixture: string): string {
  try {
    const match = README_TITLE.exec(readUtf8(path.join(fixture, "README.md")))
    return match ? (match[1] as string) : ""
  } catch (error) {
    if (error instanceof InvalidUtf8Error || isSystemError(error)) return ""
    throw error
  }
}

function prepareFixtureRepo(fixture: string, work: string, project: string): void {
  fs.cpSync(fixture, work, { recursive: true, dereference: true })
  runGitOrThrow(work, ["init", "-q"])
  runGitOrThrow(work, ["add", "-A"])
  runGitOrThrow(work, [...UNSIGNED, "commit", "-q", "-m", "init"], projectIdentity(project))
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
  runGitOrThrow(work, ["add", "-A", "--", ...OUTSIDE_FIXTURE])
  return runGitOrThrow(work, ["diff", "--cached"])
}
