import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BoundaryUsageError, fileLines, loadRules, scan } from "./boundary.ts"
import { readJsonl, readTsvRecords, TsvError } from "./datafiles.ts"
import { entryExists, InvalidUtf8Error, isExecutable, isFile, isSymlink, isSystemError, readUtf8, splitLines, walkEntries } from "./files.ts"
import { GitError, isGitRepo, runGit } from "./gitutil.ts"
import { iterRegistrations } from "./hook_settings.ts"
import { displayText, isJsonObject, parseJson } from "./json.ts"
import type { JsonObject, JsonValue } from "./json.ts"
import { FAIL, PASS, stderrExcerpt, WARN } from "./metrics.ts"
import { runProcess, TimeoutExpired } from "./subprocess.ts"
import type { RunResult } from "./subprocess.ts"
import { assertion, firstItems } from "./smoke_context.ts"
import type { Assertion, SmokeContext } from "./smoke_context.ts"

const HOOK_SCRIPT_CAP = 8
const MEMORY_INDEX_CAP_BYTES = 8192
const K5_SUBCHECK_IDS = new Set(Array.from({ length: 16 }, (_, index) => `K5.${index + 1}`))
const BULLET = /^\s*(?:[-*+]|\d+\.)\s+/
const ID_TAG = /^\[([A-Za-z0-9.-]+)\]/
const RULES_HEADING = /^##\s+Rules\b/i
const FENCE = "```"
const LINKED_DIRS = ["skills", "commands", "agents", "workflows", "bin", "mcp"]
const REPO_RULES_HEADER = ["origin_glob", "action", "pattern", "rule_id", "message"]
const LINK_CHECK_TIMEOUT_SECONDS = 60
const EMPTY_DATA_DIR_KINDS = new Set(["link-missing", "copy-missing", "settings-drift"])
const EMPTY_DATA_DIR_CLAUDE_MD = ["claude-md-drift", "generated CLAUDE.md is missing"]

type NumberedLine = [number, string]

class UnreadableSettings extends Error {}

export function checkFileCaps(ctx: SmokeContext): Assertion[] {
  return [hookScriptCap(ctx), memoryIndexCap(ctx)]
}

function hookScriptCap(ctx: SmokeContext): Assertion {
  const settingsPath = path.join(ctx.dataDir, "settings.json")
  if (!isFile(settingsPath)) return assertion("caps", "hook-scripts", PASS, "no settings.json")
  let hooks: JsonValue | undefined
  try {
    hooks = settingsHooks(settingsPath)
  } catch (error) {
    if (error instanceof UnreadableSettings) return assertion("caps", "hook-scripts", FAIL, `settings.json unreadable: ${error.message}`)
    throw error
  }
  const scripts = [...new Set(iterRegistrations(hooks).map((registration) => registration.script))].sort()
  const status = scripts.length <= HOOK_SCRIPT_CAP ? PASS : FAIL
  return assertion("caps", "hook-scripts", status, `${scripts.length}/${HOOK_SCRIPT_CAP}: ${firstItems(scripts, 10)}`)
}

function settingsHooks(settingsPath: string): JsonValue {
  let settings: JsonValue
  try {
    settings = parseJson(readUtf8(settingsPath))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error) throw new UnreadableSettings(error.message)
    throw error
  }
  if (!isJsonObject(settings)) throw new UnreadableSettings("the top level is not a JSON object")
  return settings["hooks"] ?? {}
}

function memoryIndexCap(ctx: SmokeContext): Assertion {
  const indexes = ctx.memoryIndexes()
  const oversized = indexes.filter((index) => fs.statSync(index).size > MEMORY_INDEX_CAP_BYTES).map((index) => `${index} ${fs.statSync(index).size} bytes`)
  if (oversized.length === 0) return assertion("caps", "memory-index", PASS, `${indexes.length} indexes within ${MEMORY_INDEX_CAP_BYTES} bytes`)
  return assertion("caps", "memory-index", WARN, `over ${MEMORY_INDEX_CAP_BYTES} bytes: ${firstItems(oversized)}`)
}

export function checkIdTagging(ctx: SmokeContext): Assertion[] {
  const knownIds = new Set([...ctx.countedRows.map((row) => row.id), ...K5_SUBCHECK_IDS])
  const results = [
    taggingAssertion("principles", path.join(ctx.keelHome, "PRINCIPLES.md"), knownIds, false, WARN),
    taggingAssertion("personal", path.join(ctx.overlayDir, "PERSONAL.md"), knownIds, false, PASS),
  ]
  const skillPaths: string[] = []
  for (const [root, prefix] of [[ctx.keelHome, "skill:"], [ctx.overlayDir, "skill:overlay/"]] as const) {
    for (const skillPath of skillFiles(root)) {
      skillPaths.push(skillPath)
      results.push(taggingAssertion(prefix + path.basename(path.dirname(skillPath)), skillPath, knownIds, true, PASS))
    }
  }
  results.push(skillRulesTotal(skillPaths))
  return results
}

function skillFiles(root: string): string[] {
  const skillsDir = path.join(root, "skills")
  let names: string[]
  try {
    names = fs.readdirSync(skillsDir)
  } catch {
    return []
  }
  const paths = names.filter((name) => !name.startsWith(".")).map((name) => path.join(skillsDir, name, "SKILL.md"))
  return paths.filter(entryExists).sort()
}

function taggingAssertion(scope: string, file: string, knownIds: Set<string>, rulesSectionOnly: boolean, statusWhenAbsent: string): Assertion {
  if (!isFile(file)) return assertion("id-tagging", scope, statusWhenAbsent, `absent: ${file}`)
  const checked = checkedLines(file, rulesSectionOnly)
  const problems = checked.map(([number, line]) => tagProblem(number, line, knownIds)).filter((problem): problem is string => problem !== null)
  if (problems.length > 0) return assertion("id-tagging", scope, FAIL, firstItems(problems))
  return assertion("id-tagging", scope, PASS, `${checked.length} lines checked`)
}

function skillRulesTotal(skillPaths: string[]): Assertion {
  const bullets = skillPaths.flatMap((skillPath) => checkedLines(skillPath, true)).filter(([, line]) => BULLET.test(line)).length
  return assertion("id-tagging", "skills", bullets > 0 ? PASS : FAIL, `${bullets} rule bullets across ${skillPaths.length} skills`)
}

function checkedLines(file: string, rulesSectionOnly: boolean): NumberedLine[] {
  const lines = splitLines(readUtf8(file))
  const numbered = rulesSectionOnly ? rulesSection(lines) : lines.map((line, index): NumberedLine => [index + 1, line])
  return outsideFences(numbered)
}

function rulesSection(lines: string[]): NumberedLine[] {
  const section: NumberedLine[] = []
  let inside = false
  lines.forEach((line, index) => {
    if (RULES_HEADING.test(line)) inside = true
    else if (line.startsWith("## ")) inside = false
    else if (inside) section.push([index + 1, line])
  })
  return section
}

function outsideFences(numbered: NumberedLine[]): NumberedLine[] {
  const kept: NumberedLine[] = []
  let inFence = false
  for (const [number, line] of numbered) {
    if (line.trimStart().startsWith(FENCE)) inFence = !inFence
    else if (!inFence) kept.push([number, line])
  }
  return kept
}

function tagProblem(number: number, line: string, knownIds: Set<string>): string | null {
  const bullet = BULLET.exec(line)
  if (!bullet) return null
  const tag = ID_TAG.exec(line.slice(bullet[0].length))
  if (!tag) return `line ${number}: bullet without [ID]`
  if (!knownIds.has(tag[1] as string)) return `line ${number}: unknown id [${tag[1]}]`
  return null
}

export function checkFiresRuleIds(ctx: SmokeContext): Assertion[] {
  const { records } = readJsonl(path.join(ctx.dataDir, "logs", "keel-fires.jsonl"))
  let validIds: Set<string>
  try {
    validIds = new Set([...ctx.rows.map((row) => row.id), ...repoRuleIds(ctx.overlayDir)])
  } catch (error) {
    if (error instanceof TsvError || isSystemError(error)) {
      return [assertion("fires-rule-ids", "all", FAIL, `git-guard/repo-rules.tsv unreadable: ${(error as Error).message}`)]
    }
    throw error
  }
  const unknown = [...new Set(records.filter((record) => !validIds.has(record["rule_id"] as string)).map((record) => displayText(record["rule_id"])))].sort()
  if (unknown.length > 0) return [assertion("fires-rule-ids", "all", FAIL, "unknown rule_ids: " + unknown.join(", "))]
  return [assertion("fires-rule-ids", "all", PASS, `${records.length} fires lines`)]
}

function repoRuleIds(overlayDir: string): Set<string> {
  const rulesPath = path.join(overlayDir, "git-guard", "repo-rules.tsv")
  if (!isFile(rulesPath)) return new Set()
  return new Set(readTsvRecords(rulesPath, REPO_RULES_HEADER).map((record) => record["rule_id"] as string))
}

export function checkBoundary(ctx: SmokeContext): Assertion[] {
  if (!isGitRepo(ctx.keelHome)) return [assertion("boundary", "keel", FAIL, `KEEL_HOME is not a git checkout: ${ctx.keelHome}`)]
  const lexiconPresent = isFile(path.join(ctx.overlayDir, "boundary", "lexicon.txt"))
  let rules
  let tracked: string[]
  try {
    rules = loadRules(ctx.overlayDir, !lexiconPresent)
    tracked = runGit(ctx.keelHome, ["ls-files", "-z"]).split("\0").filter((trackedPath) => trackedPath !== "")
  } catch (error) {
    if (error instanceof BoundaryUsageError || error instanceof GitError) return [assertion("boundary", "keel", FAIL, error.message)]
    throw error
  }
  const result = scan(fileLines(ctx.keelHome, tracked), rules)
  if (result.hits.length > 0) {
    const hits = result.hits.map((hit) => `${hit.file}:${hit.line} ${hit.rule}`)
    return [assertion("boundary", "keel", FAIL, `${hits.length} hits: ${firstItems(hits)}`)]
  }
  if (!lexiconPresent) return [assertion("boundary", "keel", FAIL, `overlay lexicon absent; generic rules only over ${result.scanned} lines`)]
  return [assertion("boundary", "keel", PASS, `${result.scanned} lines in ${tracked.length} tracked files`)]
}

export function checkLinkIntegrity(ctx: SmokeContext): Assertion[] {
  const tool = process.env["KEEL_LINK"] || path.join(ctx.keelHome, "bin", "link")
  if (!isExecutable(tool)) return [assertion("link-integrity", "all", FAIL, `link tool not executable: ${tool}`)]
  if (ctx.candidate) return [checkCandidateLinkPlan(tool, ctx)]
  let completed: RunResult
  try {
    completed = runProcess([tool, "--check"], { timeoutSeconds: LINK_CHECK_TIMEOUT_SECONDS })
  } catch (error) {
    if (error instanceof TimeoutExpired || isSystemError(error)) return [assertion("link-integrity", "all", FAIL, `link --check could not run: ${(error as Error).message}`)]
    throw error
  }
  if (completed.returncode === 0) return [assertion("link-integrity", "all", PASS, "link --check clean")]
  return [assertion("link-integrity", "all", FAIL, describeLinkProblems(completed))]
}

function describeLinkProblems(completed: RunResult): string {
  const problems = linkProblemsIn(completed.stdout)
  if (problems === null) return `link --check exited ${completed.returncode}: ${stderrExcerpt(completed)}`
  const described = problems.map((problem) => `${displayText(problem["kind"])} ${displayText(problem["path"])}`)
  return `link --check exited ${completed.returncode}: ${firstItems(described) || "no problems listed"}`
}

function linkProblemsIn(stdout: string): JsonObject[] | null {
  let payload: JsonValue
  try {
    payload = parseJson(stdout)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!isJsonObject(payload)) return null
  const problems = payload["problems"] ?? []
  return Array.isArray(problems) ? problems.filter(isJsonObject) : []
}

function checkCandidateLinkPlan(tool: string, ctx: SmokeContext): Assertion {
  const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-smoke-candidate-"))
  let completed: RunResult
  try {
    const linkEnv = { ...process.env, KEEL_HOME: ctx.keelHome, KEEL_OVERLAY_DIR: ctx.overlayDir, KEEL_DATA_DIR: emptyDataDir }
    try {
      completed = runProcess([tool], { timeoutSeconds: LINK_CHECK_TIMEOUT_SECONDS, env: linkEnv })
    } catch (error) {
      if (error instanceof TimeoutExpired || isSystemError(error)) return assertion("link-integrity", "all", FAIL, `link dry run could not run: ${(error as Error).message}`)
      throw error
    }
  } finally {
    fs.rmSync(emptyDataDir, { recursive: true, force: true })
  }
  const problems = dryRunProblems(completed)
  if (problems === null) return assertion("link-integrity", "all", FAIL, `link dry run exited ${completed.returncode}: ${stderrExcerpt(completed)}`)
  const unexpected = problems.filter((problem) => !isEmptyDataDirProblem(problem)).map((problem) => `${displayText(problem["kind"])}: ${displayText(problem["detail"])}`)
  if (unexpected.length > 0) return assertion("link-integrity", "all", FAIL, `candidate link plan: ${firstItems(unexpected)}`)
  return assertion("link-integrity", "all", PASS, "candidate link plan clean against an empty data dir")
}

function dryRunProblems(completed: RunResult): JsonObject[] | null {
  if (completed.returncode !== 0) return null
  let problems: JsonValue | undefined
  try {
    const payload = parseJson(completed.stdout)
    problems = isJsonObject(payload) ? payload["problems"] : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!Array.isArray(problems) || !problems.every(isJsonObject)) return null
  return problems as JsonObject[]
}

function isEmptyDataDirProblem(problem: JsonObject): boolean {
  const kind = problem["kind"]
  return (typeof kind === "string" && EMPTY_DATA_DIR_KINDS.has(kind)) || (kind === EMPTY_DATA_DIR_CLAUDE_MD[0] && problem["detail"] === EMPTY_DATA_DIR_CLAUDE_MD[1])
}

export function checkDangling(ctx: SmokeContext): Assertion[] {
  const dangling = LINKED_DIRS.flatMap((name) => danglingLinks(ctx.dataDir, path.join(ctx.dataDir, name)))
  if (dangling.length > 0) return [assertion("dangling", "data", FAIL, `${dangling.length} dangling links: ${firstItems(dangling)}`)]
  return [assertion("dangling", "data", PASS, `no dangling links under ${LINKED_DIRS.join(", ")}`)]
}

function danglingLinks(dataDir: string, top: string): string[] {
  const candidates = isSymlink(top) ? [top] : walkEntries(top)
  return candidates.filter((candidate) => isSymlink(candidate) && !fs.existsSync(candidate)).map((link) => path.relative(dataDir, link))
}
