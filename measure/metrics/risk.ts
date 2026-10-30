import fs from "node:fs"
import path from "node:path"

import * as store from "../../lib/evidence/store.ts"
import * as env from "../lib/measurekit/env.ts"
import { addDays } from "../lib/measurekit/dates.ts"
import { dateOption, parseCommandLine, printJson, runMain, stringOption, EXIT_OK } from "../lib/measurekit/cli.ts"
import type { CommandSpec } from "../lib/measurekit/cli.ts"
import { readJsonl } from "../lib/measurekit/datafiles.ts"
import { FIRES_LOG, PROCEDURAL_KIND, isSyntheticSession } from "../lib/measurekit/fireslog.ts"
import { GitError, gitSucceeds, runGit } from "../lib/measurekit/gitutil.ts"
import { compareCodePoints, isJsonObject } from "../lib/measurekit/json.ts"
import type { JsonObject } from "../lib/measurekit/json.ts"
import { isWithinWindow } from "../lib/measurekit/metrics.ts"

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
const MS_PER_MINUTE = 60_000
const PERCENT = 100
const ESCAPED_DEFECTS_NO_SOURCE = "no source"
const BASELINE_DEFERRED = "deferred"

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

interface ReviewRecord {
  evidenceId: string
  runId: string
  rootRunId: string
  repo: string
  createdAt: string
  reviewBase: string | null
  repoRoot: string | null
}

function main(argv: string[]): number {
  const since = dateOption(COMMAND, "--since", stringOption(parseCommandLine(COMMAND, argv), "since")) ?? "0000-00-00"
  const ships = shipsSince(since)
  const reviews = reviewRecords()
  const firstApprovals = firstApprovalByRootRun()
  const now = new Date()
  const items = classesPresent(ships).map((riskClass) => {
    const classShips = ships.filter((ship) => ship.riskClass === riskClass)
    return {
      class: riskClass,
      ships: classShips.length,
      escaped_defects: ESCAPED_DEFECTS_NO_SOURCE,
      rework: summarizeRework(classShips.map((ship) => reworkOf(ship, reviews, now))),
      review_to_approval: summarizeApprovalWait(classShips, reviews, firstApprovals),
      baseline: BASELINE_DEFERRED,
    }
  })
  printJson({ count: ships.filter((ship) => ship.riskClass !== UNCLASSIFIED).length, items })
  return EXIT_OK
}

function shipsSince(since: string): Ship[] {
  const { records } = readJsonl(path.join(env.logsDir(), FIRES_LOG))
  const ships = new Map<string, Ship>()
  for (const record of records) {
    if (!isCountedPass(record, since)) continue
    const repo = record["repo"]
    const head = record["head"]
    if (typeof repo !== "string") continue
    const key = typeof head === "string" ? `${repo.toLowerCase()} ${head}` : `${repo.toLowerCase()} ${record["ts"]}`
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

function isCountedPass(record: JsonObject, since: string): boolean {
  return record["rule_id"] === RULE_ID && record["outcome"] === PASS_OUTCOME && record["kind"] !== PROCEDURAL_KIND
    && !isSyntheticSession(record["session"]) && isWithinWindow(record, since)
}

function classesPresent(ships: Ship[]): string[] {
  const present = new Set(ships.map((ship) => ship.riskClass))
  const known = CLASS_ORDER.filter((riskClass) => present.has(riskClass))
  const other = [...present].filter((riskClass) => !CLASS_ORDER.includes(riskClass) && riskClass !== UNCLASSIFIED).sort(compareCodePoints)
  return [...known, ...other, ...(present.has(UNCLASSIFIED) ? [UNCLASSIFIED] : [])]
}

function reviewRecords(): ReviewRecord[] {
  return store.repoKeys("review").flatMap((repoKey) => store.listFiles("review", repoKey).map((file) => store.readFile(file) as JsonObject))
    .filter((review) => typeof review["evidence_id"] === "string" && typeof review["run_id"] === "string" && typeof review["repo"] === "string")
    .map((review) => ({
      evidenceId: review["evidence_id"] as string,
      runId: review["run_id"] as string,
      rootRunId: typeof review["root_run_id"] === "string" ? review["root_run_id"] : review["run_id"] as string,
      repo: review["repo"] as string,
      createdAt: review["created_at"] as string,
      reviewBase: typeof review["review_base"] === "string" ? review["review_base"] : null,
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
  return { approved_ships: waits.length, without_approval: ships.length - waits.length, median_minutes: median(waits) }
}

function approvalWaitMinutes(ship: Ship, reviews: ReviewRecord[], firstApprovals: Map<string, JsonObject>): number | null {
  const approval = ship.rootRunId === null ? undefined : firstApprovals.get(ship.rootRunId)
  const heads = approval?.["heads"]
  if (approval === undefined || !isJsonObject(heads)) return null
  const headEvidenceId = heads[ship.repo]
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

function reworkOf(ship: Ship, reviews: ReviewRecord[], now: Date): Rework {
  const horizonDate = addDays(ship.shippedAt.slice(0, 10), REWORK_DAYS) + ship.shippedAt.slice(10)
  if (Date.parse(horizonDate) > now.getTime()) return { state: "pending" }
  if (ship.head === null) return { state: "not computable", reason: "no head" }
  if (ship.rootRunId === null) return { state: "not computable", reason: "no root run id" }
  const rootReview = reviews.find((review) => review.runId === ship.rootRunId && review.rootRunId === ship.rootRunId && sameRepo(review.repo, ship.repo))
  if (rootReview === undefined) return { state: "not computable", reason: "no root review evidence" }
  if (rootReview.reviewBase === null) return { state: "not computable", reason: "no review base" }
  const checkout = checkoutHolding(ship.repo, ship.head, reviews)
  if (checkout === null) return { state: "not computable", reason: "no local checkout holds the head" }
  try {
    return reworkInCheckout(checkout, rootReview.reviewBase, ship.head, horizonDate)
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

function reworkInCheckout(checkout: string, base: string, head: string, horizonDate: string): Rework {
  if (!gitSucceeds(checkout, ["rev-parse", "--verify", "--quiet", DEFAULT_BRANCH_REF])) return { state: "not computable", reason: "no origin/HEAD" }
  if (!gitSucceeds(checkout, ["merge-base", "--is-ancestor", head, DEFAULT_BRANCH_REF])) return { state: "not computable", reason: "head not on the default branch" }
  const horizon = runGit(checkout, ["rev-list", "-1", "--first-parent", `--before=${horizonDate}`, DEFAULT_BRANCH_REF]).trim()
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
