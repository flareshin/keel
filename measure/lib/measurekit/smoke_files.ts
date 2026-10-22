import fs from "node:fs"
import os from "node:os"

import { BoundaryUsageError, fileLines, loadRules, scan } from "./boundary.ts"
import { readJsonl, readTsvRecords, TsvError } from "./datafiles.ts"
import { GitError, isGitRepo, runGit } from "./gitutil.ts"
import { iterRegistrations } from "./hook_settings.ts"
import { FAIL, PASS, stderrExcerpt, WARN } from "./metrics.ts"
import { isOsError, ValueError } from "./pyerrors.ts"
import { readText, textLines } from "./pyio.ts"
import { pythonJsonLoads } from "./pyjson.ts"
import { isExecutable, isFile, isLink, pathExists, pyBasename, pyDirname, pyJoin, pyRelpath, walk } from "./pypath.ts"
import { compilePythonRegex } from "./pyregex.ts"
import { pyLstrip, sortedByCodePoint } from "./pystr.ts"
import { isJsonObject, pyStr, pyTypeName } from "./pyvalue.ts"
import type { JsonObject, PyValue } from "./pyvalue.ts"
import { runProcess, TimeoutExpired } from "./subprocess.ts"
import type { RunResult } from "./subprocess.ts"
import { assertion, firstItems } from "./smoke_context.ts"
import type { Assertion, SmokeContext } from "./smoke_context.ts"

const HOOK_SCRIPT_CAP = 8
const MEMORY_INDEX_CAP_BYTES = 8192
const K5_SUBCHECK_IDS = new Set(Array.from({ length: 16 }, (_, index) => `K5.${index + 1}`))
const BULLET = compilePythonRegex("^\\s*(?:[-*+]|\\d+\\.)\\s+")
const ID_TAG = compilePythonRegex("^\\[([A-Za-z0-9.-]+)\\]")
export const RULES_HEADING_PATTERN = "(?i)^##\\s+Rules\\b"
const RULES_HEADING = compilePythonRegex(RULES_HEADING_PATTERN)
const FENCE = "```"
const LINKED_DIRS = ["skills", "commands", "agents", "workflows", "bin", "mcp"]
const REPO_RULES_HEADER = ["origin_glob", "action", "pattern", "rule_id", "message"]
const LINK_CHECK_TIMEOUT_SECONDS = 60
const EMPTY_DATA_DIR_KINDS = new Set(["link-missing", "copy-missing", "settings-drift"])
const EMPTY_DATA_DIR_CLAUDE_MD = ["claude-md-drift", "generated CLAUDE.md is missing"]

type NumberedLine = [number, string]

export function checkFileCaps(ctx: SmokeContext): Assertion[] {
  return [hookScriptCap(ctx), memoryIndexCap(ctx)]
}

function hookScriptCap(ctx: SmokeContext): Assertion {
  const settingsPath = pyJoin(ctx.dataDir, "settings.json")
  if (!isFile(settingsPath)) return assertion("caps", "hook-scripts", PASS, "no settings.json")
  let hooks: PyValue | undefined
  try {
    const settings = pythonJsonLoads(readText(settingsPath))
    if (!isJsonObject(settings)) throw new ValueError(`'${pyTypeName(settings)}' object has no attribute 'get'`)
    hooks = settings["hooks"] ?? {}
  } catch (error) {
    if (error instanceof ValueError) return assertion("caps", "hook-scripts", FAIL, `settings.json unreadable: ${error.message}`)
    throw error
  }
  const scripts = sortedByCodePoint(new Set(iterRegistrations(hooks).map((registration) => registration.script)))
  const status = scripts.length <= HOOK_SCRIPT_CAP ? PASS : FAIL
  return assertion("caps", "hook-scripts", status, `${scripts.length}/${HOOK_SCRIPT_CAP}: ${firstItems(scripts, 10)}`)
}

function memoryIndexCap(ctx: SmokeContext): Assertion {
  const indexes = ctx.memoryIndexes()
  const oversized = indexes.filter((path) => fs.statSync(path).size > MEMORY_INDEX_CAP_BYTES).map((path) => `${path} ${fs.statSync(path).size} bytes`)
  if (oversized.length === 0) return assertion("caps", "memory-index", PASS, `${indexes.length} indexes within ${MEMORY_INDEX_CAP_BYTES} bytes`)
  return assertion("caps", "memory-index", WARN, `over ${MEMORY_INDEX_CAP_BYTES} bytes: ${firstItems(oversized)}`)
}

export function checkIdTagging(ctx: SmokeContext): Assertion[] {
  const knownIds = new Set([...ctx.countedRows.map((row) => row.id), ...K5_SUBCHECK_IDS])
  const results = [
    taggingAssertion("principles", pyJoin(ctx.keelHome, "PRINCIPLES.md"), knownIds, false, WARN),
    taggingAssertion("personal", pyJoin(ctx.overlayDir, "PERSONAL.md"), knownIds, false, PASS),
  ]
  const skillPaths: string[] = []
  for (const [root, prefix] of [[ctx.keelHome, "skill:"], [ctx.overlayDir, "skill:overlay/"]] as const) {
    for (const path of skillFiles(root)) {
      skillPaths.push(path)
      results.push(taggingAssertion(prefix + pyBasename(pyDirname(path)), path, knownIds, true, PASS))
    }
  }
  results.push(skillRulesTotal(skillPaths))
  return results
}

function skillFiles(root: string): string[] {
  const skillsDir = pyJoin(root, "skills")
  let names: string[]
  try {
    names = fs.readdirSync(skillsDir)
  } catch {
    return []
  }
  const paths = names.filter((name) => !name.startsWith(".")).map((name) => pyJoin(skillsDir, name, "SKILL.md"))
  return sortedByCodePoint(paths.filter((path) => lexists(path)))
}

function lexists(path: string): boolean {
  try {
    fs.lstatSync(path)
    return true
  } catch {
    return false
  }
}

function taggingAssertion(scope: string, path: string, knownIds: Set<string>, rulesSectionOnly: boolean, statusWhenAbsent: string): Assertion {
  if (!isFile(path)) return assertion("id-tagging", scope, statusWhenAbsent, `absent: ${path}`)
  const checked = checkedLines(path, rulesSectionOnly)
  const problems = checked.map(([number, line]) => tagProblem(number, line, knownIds)).filter((problem): problem is string => problem !== null)
  if (problems.length > 0) return assertion("id-tagging", scope, FAIL, firstItems(problems))
  return assertion("id-tagging", scope, PASS, `${checked.length} lines checked`)
}

function skillRulesTotal(skillPaths: string[]): Assertion {
  const bullets = skillPaths.flatMap((path) => checkedLines(path, true)).filter(([, line]) => BULLET.test(line)).length
  return assertion("id-tagging", "skills", bullets > 0 ? PASS : FAIL, `${bullets} rule bullets across ${skillPaths.length} skills`)
}

function checkedLines(path: string, rulesSectionOnly: boolean): NumberedLine[] {
  const lines = textLines(readText(path))
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
    if (pyLstrip(line).startsWith(FENCE)) inFence = !inFence
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
  const { records } = readJsonl(pyJoin(ctx.dataDir, "logs", "keel-fires.jsonl"))
  let validIds: Set<string>
  try {
    validIds = new Set([...ctx.rows.map((row) => row.id), ...repoRuleIds(ctx.overlayDir)])
  } catch (error) {
    if (error instanceof TsvError || isOsError(error)) {
      return [assertion("fires-rule-ids", "all", FAIL, `git-guard/repo-rules.tsv unreadable: ${(error as Error).message}`)]
    }
    throw error
  }
  const unknown = sortedByCodePoint(new Set(records.filter((record) => !validIds.has(record["rule_id"] as string)).map((record) => pyStr(record["rule_id"]))))
  if (unknown.length > 0) return [assertion("fires-rule-ids", "all", FAIL, "unknown rule_ids: " + unknown.join(", "))]
  return [assertion("fires-rule-ids", "all", PASS, `${records.length} fires lines`)]
}

function repoRuleIds(overlayDir: string): Set<string> {
  const path = pyJoin(overlayDir, "git-guard", "repo-rules.tsv")
  if (!isFile(path)) return new Set()
  return new Set(readTsvRecords(path, REPO_RULES_HEADER).map((record) => record["rule_id"] as string))
}

export function checkBoundary(ctx: SmokeContext): Assertion[] {
  if (!isGitRepo(ctx.keelHome)) return [assertion("boundary", "keel", FAIL, `KEEL_HOME is not a git checkout: ${ctx.keelHome}`)]
  const lexiconPresent = isFile(pyJoin(ctx.overlayDir, "boundary", "lexicon.txt"))
  let rules
  let tracked: string[]
  try {
    rules = loadRules(ctx.overlayDir, !lexiconPresent)
    tracked = runGit(ctx.keelHome, ["ls-files", "-z"]).split("\0").filter((path) => path !== "")
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
  const tool = process.env["KEEL_LINK"] || pyJoin(ctx.keelHome, "bin", "link")
  if (!isExecutable(tool)) return [assertion("link-integrity", "all", FAIL, `link tool not executable: ${tool}`)]
  if (ctx.candidate) return [checkCandidateLinkPlan(tool, ctx)]
  let completed: RunResult
  try {
    completed = runProcess([tool, "--check"], { timeoutSeconds: LINK_CHECK_TIMEOUT_SECONDS })
  } catch (error) {
    if (error instanceof TimeoutExpired || isOsError(error)) return [assertion("link-integrity", "all", FAIL, `link --check could not run: ${(error as Error).message}`)]
    throw error
  }
  if (completed.returncode === 0) return [assertion("link-integrity", "all", PASS, "link --check clean")]
  return [assertion("link-integrity", "all", FAIL, describeLinkProblems(completed))]
}

function describeLinkProblems(completed: RunResult): string {
  let problems: PyValue | undefined
  try {
    const payload = pythonJsonLoads(completed.stdout)
    if (!isJsonObject(payload)) throw new ValueError("not an object")
    problems = payload["problems"] ?? []
  } catch (error) {
    if (error instanceof ValueError) return `link --check exited ${completed.returncode}: ${stderrExcerpt(completed)}`
    throw error
  }
  const listed = Array.isArray(problems) ? problems : []
  const described = listed.filter(isJsonObject).map((problem) => `${pyStr(problem["kind"])} ${pyStr(problem["path"])}`)
  return `link --check exited ${completed.returncode}: ${firstItems(described) || "no problems listed"}`
}

function checkCandidateLinkPlan(tool: string, ctx: SmokeContext): Assertion {
  const emptyDataDir = fs.mkdtempSync(pyJoin(os.tmpdir(), "keel-smoke-candidate-"))
  let completed: RunResult
  try {
    const linkEnv = { ...process.env, KEEL_HOME: ctx.keelHome, KEEL_OVERLAY_DIR: ctx.overlayDir, KEEL_DATA_DIR: emptyDataDir }
    try {
      completed = runProcess([tool], { timeoutSeconds: LINK_CHECK_TIMEOUT_SECONDS, env: linkEnv })
    } catch (error) {
      if (error instanceof TimeoutExpired || isOsError(error)) return assertion("link-integrity", "all", FAIL, `link dry run could not run: ${(error as Error).message}`)
      throw error
    }
  } finally {
    fs.rmSync(emptyDataDir, { recursive: true, force: true })
  }
  const problems = dryRunProblems(completed)
  if (problems === null) return assertion("link-integrity", "all", FAIL, `link dry run exited ${completed.returncode}: ${stderrExcerpt(completed)}`)
  const unexpected = problems.filter((problem) => !isEmptyDataDirProblem(problem)).map((problem) => `${pyStr(problem["kind"])}: ${pyStr(problem["detail"])}`)
  if (unexpected.length > 0) return assertion("link-integrity", "all", FAIL, `candidate link plan: ${firstItems(unexpected)}`)
  return assertion("link-integrity", "all", PASS, "candidate link plan clean against an empty data dir")
}

function dryRunProblems(completed: RunResult): JsonObject[] | null {
  if (completed.returncode !== 0) return null
  let problems: PyValue | undefined
  try {
    const payload = pythonJsonLoads(completed.stdout)
    problems = isJsonObject(payload) ? payload["problems"] : undefined
  } catch (error) {
    if (error instanceof ValueError) return null
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
  const dangling = LINKED_DIRS.flatMap((name) => danglingLinks(ctx.dataDir, pyJoin(ctx.dataDir, name)))
  if (dangling.length > 0) return [assertion("dangling", "data", FAIL, `${dangling.length} dangling links: ${firstItems(dangling)}`)]
  return [assertion("dangling", "data", PASS, `no dangling links under ${LINKED_DIRS.join(", ")}`)]
}

function danglingLinks(dataDir: string, top: string): string[] {
  if (isLink(top)) return pathExists(top) ? [] : [pyRelpath(top, dataDir)]
  const found: string[] = []
  for (const { current, dirNames, fileNames } of walk(top)) {
    for (const name of sortedByCodePoint([...dirNames, ...fileNames])) {
      const path = pyJoin(current, name)
      if (isLink(path) && !pathExists(path)) found.push(pyRelpath(path, dataDir))
    }
  }
  return found
}
