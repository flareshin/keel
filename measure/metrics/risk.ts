import fs from "node:fs"
import path from "node:path"

import { stateDir } from "../../lib/evidence/env.ts"
import { writeTextAtomic } from "../../lib/link/atomic.ts"
import * as store from "../../lib/evidence/store.ts"
import * as env from "../lib/measurekit/env.ts"
import { addDays } from "../lib/measurekit/dates.ts"
import { dateOption, parseCommandLine, printJson, runMain, stringOption, EXIT_OK } from "../lib/measurekit/cli.ts"
import type { CommandSpec } from "../lib/measurekit/cli.ts"
import { readJsonl } from "../lib/measurekit/datafiles.ts"
import { FIRES_LOG } from "../lib/measurekit/fireslog.ts"
import { GitError, gitSucceeds, runGit } from "../lib/measurekit/gitutil.ts"
import { compareCodePoints, isJsonObject, parseJson, stringifySorted } from "../lib/measurekit/json.ts"
import type { JsonObject } from "../lib/measurekit/json.ts"
import { isCountedFire, isWithinWindow } from "../lib/measurekit/metrics.ts"

const COMMAND: CommandSpec = {
  prog: "measure/metrics/risk",
  usage: "measure/metrics/risk --since YYYY-MM-DD",
  description: "Report the DESIGN 6.1 risk pilot inputs per class: ships, rework, review-to-approval time; name each input it cannot compute.",
  argumentHelp: [["--since YYYY-MM-DD", "window start"]],
  options: { since: { type: "string" } },
}
const RULE_ID = "risk"
const PASS_OUTCOME = "pass"
const CLASS_ORDER = ["light", "standard", "heavy", "smoke-only"]
const UNCLASSIFIED = "unclassified"
const REWORK_DAYS = 14
const REFACTOR_ONLY_SUBJECT = /^(?:refactor|rename|move)\b/i
const DEFAULT_BRANCH_REF = "refs/remotes/origin/HEAD"
const ORIGIN_BRANCH_PREFIX = "refs/remotes/origin/"
const MS_PER_MINUTE = 60_000
const PERCENT = 100
const ESCAPED_DEFECTS_NO_SOURCE = "no source"
const BASELINE_DEFERRED = "deferred"
const REWORK_CACHE_FILE = path.join("metrics", "risk-rework.json")
const PRIVATE_FILE_MODE = 0o600
const UNREADABLE_CACHE_CODES = new Set(["EACCES", "EISDIR"])

interface Ship {
  repo: string
  head: string | null
  rootRunId: string | null
  riskClass: string
  shippedAt: string
}

type Rework =
  | { state: "decided"; shipped: number; reworked: number }
  | { state: "pending" }
  | { state: "not computable"; reason: string }

type DecidedRework = Extract<Rework, { state: "decided" }>

interface ReviewRecord {
  evidenceId: string
  repo: string
  createdAt: string
  repoRoot: string | null
}

function main(argv: string[]): number {
  const since = dateOption(COMMAND, "--since", stringOption(parseCommandLine(COMMAND, argv), "since")) ?? "0000-00-00"
  const allShips = shipsSince("0000-00-00")
  const ships = allShips.filter((ship) => isWithinWindow({ ts: ship.shippedAt }, since))
  const reviews = reviewRecords()
  const firstApprovals = firstApprovalByRootRun()
  const now = new Date()
  const cache = readReworkCache()
  const cachedShips = cache.size
  const items = classesPresent(ships).map((riskClass) => {
    const classShips = ships.filter((ship) => ship.riskClass === riskClass)
    return {
      class: riskClass,
      ships: classShips.length,
      escaped_defects: ESCAPED_DEFECTS_NO_SOURCE,
      rework: summarizeRework(classShips.map((ship) => cachedRework(ship, cache, () => reworkOf(ship, allShips, reviews, now)))),
      review_to_approval: summarizeApprovalWait(classShips, reviews, firstApprovals),
      baseline: BASELINE_DEFERRED,
    }
  })
  if (cache.size > cachedShips) writeReworkCache(cache)
  printJson({ count: ships.filter((ship) => ship.riskClass !== UNCLASSIFIED).length, items })
  return EXIT_OK
}

function shipsSince(since: string): Ship[] {
  const { records } = readJsonl(path.join(env.logsDir(), FIRES_LOG))
  const ships = new Map<string, Ship>()
  for (const record of records) {
    if (record["rule_id"] !== RULE_ID || record["outcome"] !== PASS_OUTCOME || !isCountedFire(record, since)) continue
    const repo = record["repo"]
    const head = record["head"]
    if (typeof repo !== "string") continue
    const key = shipKey(repo, typeof head === "string" ? head : record["ts"] as string)
    if (ships.has(key)) continue
    ships.set(key, {
      repo,
      head: typeof head === "string" ? head : null,
      rootRunId: typeof record["root_run_id"] === "string" ? record["root_run_id"] : null,
      riskClass: typeof record["risk"] === "string" ? record["risk"] : UNCLASSIFIED,
      shippedAt: record["ts"] as string,
    })
  }
  return [...ships.values()]
}

function shipKey(repo: string, headOrTimestamp: string): string {
  return `${repo.toLowerCase()} ${headOrTimestamp}`
}

function classesPresent(ships: Ship[]): string[] {
  const present = new Set(ships.map((ship) => ship.riskClass))
  const known = CLASS_ORDER.filter((riskClass) => present.has(riskClass))
  const other = [...present].filter((riskClass) => !CLASS_ORDER.includes(riskClass) && riskClass !== UNCLASSIFIED).sort(compareCodePoints)
  return [...known, ...other, ...(present.has(UNCLASSIFIED) ? [UNCLASSIFIED] : [])]
}

function reviewRecords(): ReviewRecord[] {
  return store.repoKeys("review").flatMap((repoKey) => store.listFiles("review", repoKey).map((file) => store.readFile(file) as JsonObject))
    .filter((review) => typeof review["evidence_id"] === "string" && typeof review["repo"] === "string")
    .map((review) => ({
      evidenceId: review["evidence_id"] as string,
      repo: review["repo"] as string,
      createdAt: review["created_at"] as string,
      repoRoot: typeof review["repo_root"] === "string" ? review["repo_root"] : null,
    }))
}

function firstApprovalByRootRun(): Map<string, JsonObject> {
  const approvals = store.listFiles("approval").map((file) => store.readFile(file) as JsonObject)
    .filter((approval) => typeof approval["root_run_id"] === "string" && typeof approval["created_at"] === "string")
    .sort((left, right) => compareCodePoints(left["created_at"] as string, right["created_at"] as string))
  const first = new Map<string, JsonObject>()
  for (const approval of approvals) {
    const rootRunId = approval["root_run_id"] as string
    if (!first.has(rootRunId)) first.set(rootRunId, approval)
  }
  return first
}

function summarizeApprovalWait(ships: Ship[], reviews: ReviewRecord[], firstApprovals: Map<string, JsonObject>) {
  const waits = ships.map((ship) => approvalWaitMinutes(ship, reviews, firstApprovals)).filter((wait): wait is number => wait !== null)
  return { approved_ships: waits.length, no_approval_evidence: ships.length - waits.length, median_minutes: median(waits) }
}

function approvalWaitMinutes(ship: Ship, reviews: ReviewRecord[], firstApprovals: Map<string, JsonObject>): number | null {
  const approval = ship.rootRunId === null ? undefined : firstApprovals.get(ship.rootRunId)
  const heads = approval?.["heads"]
  if (approval === undefined || !isJsonObject(heads)) return null
  const headEvidenceId = Object.entries(heads).find(([repo]) => sameRepo(repo, ship.repo))?.[1]
  const headReview = reviews.find((review) => review.evidenceId === headEvidenceId)
  if (headReview === undefined) return null
  return Math.round((Date.parse(approval["created_at"] as string) - Date.parse(headReview.createdAt)) / MS_PER_MINUTE)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function summarizeRework(results: Rework[]) {
  const decided = results.filter((result): result is Extract<Rework, { state: "decided" }> => result.state === "decided")
  const shippedLines = decided.reduce((sum, result) => sum + result.shipped, 0)
  const reworkedLines = decided.reduce((sum, result) => sum + result.reworked, 0)
  const notComputable = results.filter((result): result is Extract<Rework, { state: "not computable" }> => result.state === "not computable")
  return {
    decided_ships: decided.length,
    pending_ships: results.filter((result) => result.state === "pending").length,
    not_computable: countReasons(notComputable.map((result) => result.reason)),
    shipped_lines: shippedLines,
    reworked_lines: reworkedLines,
    rate_percent: shippedLines === 0 ? null : Math.round((reworkedLines / shippedLines) * PERCENT * 10) / 10,
  }
}

function countReasons(reasons: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const reason of [...reasons].sort(compareCodePoints)) counts[reason] = (counts[reason] ?? 0) + 1
  return counts
}

function cachedRework(ship: Ship, cache: Map<string, DecidedRework>, compute: () => Rework): Rework {
  const key = ship.head === null ? null : shipKey(ship.repo, ship.head)
  const cached = key === null ? undefined : cache.get(key)
  if (cached !== undefined) return cached
  const rework = compute()
  if (key !== null && rework.state === "decided") cache.set(key, rework)
  return rework
}

function readReworkCache(): Map<string, DecidedRework> {
  const file = path.join(stateDir(), REWORK_CACHE_FILE)
  if (!fs.existsSync(file)) return new Map()
  let parsed: unknown
  try {
    parsed = parseJson(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError || UNREADABLE_CACHE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return new Map()
    throw error
  }
  if (!isJsonObject(parsed)) return new Map()
  const cache = new Map<string, DecidedRework>()
  for (const [key, entry] of Object.entries(parsed)) {
    if (isJsonObject(entry) && Number.isInteger(entry["shipped"]) && Number.isInteger(entry["reworked"])) {
      cache.set(key, { state: "decided", shipped: entry["shipped"] as number, reworked: entry["reworked"] as number })
    }
  }
  return cache
}

function writeReworkCache(cache: Map<string, DecidedRework>): void {
  const entries = Object.fromEntries([...cache].map(([key, rework]) => [key, { shipped: rework.shipped, reworked: rework.reworked }]))
  writeTextAtomic(path.join(stateDir(), REWORK_CACHE_FILE), stringifySorted(entries) + "\n", PRIVATE_FILE_MODE)
}

function reworkOf(ship: Ship, allShips: Ship[], reviews: ReviewRecord[], now: Date): Rework {
  const horizonDate = addDays(ship.shippedAt.slice(0, 10), REWORK_DAYS) + ship.shippedAt.slice(10)
  if (Date.parse(horizonDate) > now.getTime()) return { state: "pending" }
  if (ship.head === null) return { state: "not computable", reason: "no head" }
  const checkout = checkoutHolding(ship.repo, ship.head, reviews)
  if (checkout === null) return { state: "not computable", reason: "no local checkout holds the head" }
  const earlierHeads = allShips
    .filter((other) => sameRepo(other.repo, ship.repo) && other.head !== null && other.head !== ship.head && other.shippedAt < ship.shippedAt)
    .sort((left, right) => compareCodePoints(right.shippedAt, left.shippedAt))
    .map((other) => other.head as string)
  try {
    return reworkInCheckout(checkout, ship.head, earlierHeads, horizonDate)
  } catch (error) {
    if (error instanceof GitError) return { state: "not computable", reason: "git could not read the ship" }
    throw error
  }
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function checkoutHolding(repo: string, head: string, reviews: ReviewRecord[]): string | null {
  const roots = new Set(reviews.filter((review) => sameRepo(review.repo, repo) && review.repoRoot !== null).map((review) => review.repoRoot as string))
  for (const root of roots) {
    if (fs.existsSync(root) && gitSucceeds(root, ["cat-file", "-e", `${head}^{commit}`])) return root
  }
  return null
}

function reworkInCheckout(checkout: string, head: string, earlierHeads: string[], horizonDate: string): Rework {
  if (!gitSucceeds(checkout, ["rev-parse", "--verify", "--quiet", DEFAULT_BRANCH_REF])) return { state: "not computable", reason: "no origin/HEAD" }
  if (!isAncestor(checkout, head, DEFAULT_BRANCH_REF)) return { state: "not computable", reason: "head not on the default branch" }
  if (!defaultBranchSeenPast(checkout, horizonDate)) return { state: "not computable", reason: "default branch not fetched past the horizon" }
  const horizon = runGit(checkout, ["rev-list", "-1", "--first-parent", `--before=${horizonDate}`, DEFAULT_BRANCH_REF]).trim()
  if (horizon === "" || !isAncestor(checkout, head, horizon)) return { state: "not computable", reason: "head reached the default branch after the horizon" }
  const base = shipBase(checkout, head, earlierHeads)
  if (base === null) return { state: "not computable", reason: "no earlier ship bounds a fast-forwarded head" }
  const shipCommits = new Set(lines(runGit(checkout, ["rev-list", "--first-parent", `${base}..${head}`])))
  const refactorCommits = refactorOnlyCommits(checkout, head, horizon)
  const renames = renamesBetween(checkout, head, horizon)
  let shipped = 0
  let survived = 0
  for (const file of lines(runGit(checkout, ["diff", "--name-only", "--diff-filter=AMR", base, head]))) {
    shipped += blamedToShip(checkout, head, file, shipCommits, [])
    const later = renames.get(file) ?? file
    survived += gitSucceeds(checkout, ["cat-file", "-e", `${horizon}:${later}`]) ? blamedToShip(checkout, horizon, later, shipCommits, refactorCommits) : 0
  }
  return { state: "decided", shipped, reworked: Math.max(shipped - survived, 0) }
}

function defaultBranchSeenPast(checkout: string, horizonDate: string): boolean {
  const horizon = Date.parse(horizonDate)
  const tipDate = runGit(checkout, ["log", "-1", "--format=%cI", DEFAULT_BRANCH_REF]).trim()
  if (Date.parse(tipDate) >= horizon) return true
  if (!gitSucceeds(checkout, ["symbolic-ref", "-q", DEFAULT_BRANCH_REF])) return false
  if (!gitSucceeds(checkout, ["remote", "get-url", "origin"])) return false
  const branch = runGit(checkout, ["symbolic-ref", DEFAULT_BRANCH_REF]).trim().slice(ORIGIN_BRANCH_PREFIX.length)
  const originFetch = `\tbranch '${branch}' of ${asFetchHeadUrl(runGit(checkout, ["remote", "get-url", "origin"]).trim())}`
  return fetchHeadsOfRepo(checkout)
    .filter((fetchHead) => fs.statSync(fetchHead).mtimeMs >= horizon)
    .some((fetchHead) => fs.readFileSync(fetchHead, "utf8").split("\n").some((line) => line.endsWith(originFetch)))
}

function fetchHeadsOfRepo(checkout: string): string[] {
  const commonDir = path.resolve(checkout, runGit(checkout, ["rev-parse", "--git-common-dir"]).trim())
  const worktreesDir = path.join(commonDir, "worktrees")
  const worktreeDirs = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir).map((name) => path.join(worktreesDir, name)) : []
  return [commonDir, ...worktreeDirs].map((gitDir) => path.join(gitDir, "FETCH_HEAD")).filter((fetchHead) => fs.existsSync(fetchHead))
}

function asFetchHeadUrl(url: string): string {
  const withoutUser = url.includes("://") ? url.replace(/^([^:/]+:\/\/)[^/@]*@/, "$1") : url.replace(/^[^/:@]*@(?=[^/:]*:)/, "")
  return withoutUser.replace(/\/+$/, "").replace(/\.git$/, "")
}

function isAncestor(checkout: string, ancestor: string, descendant: string): boolean {
  return gitSucceeds(checkout, ["merge-base", "--is-ancestor", ancestor, descendant])
}

function shipBase(checkout: string, head: string, earlierHeads: string[]): string | null {
  const landing = lines(runGit(checkout, ["rev-list", "--first-parent", "--ancestry-path", `${head}..${DEFAULT_BRANCH_REF}`])).at(-1)
  const landedByMerge = landing !== undefined && runGit(checkout, ["rev-parse", `${landing}^1`]).trim() !== head
  if (landedByMerge) return runGit(checkout, ["merge-base", head, `${landing}^1`]).trim()
  const firstParentChain = new Set(lines(runGit(checkout, ["rev-list", "--first-parent", head])))
  return earlierHeads.find((earlier) => firstParentChain.has(earlier)) ?? null
}

function refactorOnlyCommits(checkout: string, head: string, horizon: string): string[] {
  return lines(runGit(checkout, ["log", "--format=%H %s", `${head}..${horizon}`]))
    .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)] as const)
    .filter(([, subject]) => REFACTOR_ONLY_SUBJECT.test(subject))
    .map(([commit]) => commit)
}

function renamesBetween(checkout: string, from: string, to: string): Map<string, string> {
  const renames = new Map<string, string>()
  for (const line of lines(runGit(checkout, ["diff", "--name-status", "-M", "--diff-filter=R", from, to]))) {
    const [, oldPath, newPath] = line.split("\t")
    if (oldPath !== undefined && newPath !== undefined) renames.set(oldPath, newPath)
  }
  return renames
}

function blamedToShip(checkout: string, revision: string, file: string, shipCommits: Set<string>, ignored: string[]): number {
  const ignoreArgs = ignored.flatMap((commit) => ["--ignore-rev", commit])
  const porcelain = runGit(checkout, ["blame", "--line-porcelain", "-w", ...ignoreArgs, revision, "--", file])
  return porcelain.split("\n").filter((line) => /^[0-9a-f]{40} /.test(line) && shipCommits.has(line.slice(0, 40))).length
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "")
}

runMain(main)
