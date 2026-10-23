import fs from "node:fs"

import { KEEL_SOURCE, OVERLAY_SOURCE, validateRow } from "./ledger.ts"
import type { LedgerRow } from "./ledger.ts"
import { evaluateMetric, FAIL, GRACE, PASS, WARN } from "./metrics.ts"
import { isFile, pyBasename, pyJoin } from "./pypath.ts"
import { isPastReview } from "./propose.ts"
import { sortedByCodePoint } from "./pystr.ts"
import { assertion, firstItems } from "./smoke_context.ts"
import type { Assertion, SmokeContext } from "./smoke_context.ts"

const CHARTER_CAP = 7
const CORE_CAP = 10
const STACK_CAP = 10
const STACKS_CAP = 5
const OVERLAY_CAP = 15
const MIN_INCIDENTS = 2
const PRIVATE_REF_PREFIX = "private:"
const SOURCES = [KEEL_SOURCE, OVERLAY_SOURCE]

export function checkLedgerFormat(ctx: SmokeContext): Assertion[] {
  return ctx.ledgers.map((ledger) => {
    if (!ledger.present) {
      const status = ledger.source === KEEL_SOURCE ? FAIL : PASS
      return assertion("ledger-format", ledger.source, status, `no ledger at ${ledger.path}`)
    }
    const problems = [...ledger.problems, ...ledger.rows.flatMap(validateRow)]
    const detail = problems.length > 0 ? firstItems(problems) : `${ledger.rows.length} rows`
    return assertion("ledger-format", ledger.source, problems.length > 0 ? FAIL : PASS, detail)
  })
}

export function checkIdUnique(ctx: SmokeContext): Assertion[] {
  const counts = new Map<string, number>()
  for (const row of ctx.rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const duplicates = sortedByCodePoint([...counts].filter(([, count]) => count > 1).map(([id]) => id))
  if (duplicates.length > 0) return [assertion("id-unique", "all", FAIL, "duplicate ids: " + duplicates.join(", "))]
  return [assertion("id-unique", "all", PASS, `${ctx.rows.length} ids`)]
}

export function checkRowCaps(ctx: SmokeContext): Assertion[] {
  const rows = ctx.countedRows
  const stackScopes = sortedByCodePoint(new Set(rows.filter((row) => row.scope.startsWith("stack:")).map((row) => row.scope)))
  const countOf = (predicate: (row: LedgerRow) => boolean): number => rows.filter(predicate).length
  return [
    cap("charter", countOf((row) => row.scope === "charter"), CHARTER_CAP),
    cap("core", countOf((row) => row.scope === "core" && row.type !== "floor"), CORE_CAP),
    ...stackScopes.map((scope) => cap(scope, countOf((row) => row.scope === scope), STACK_CAP)),
    cap("stacks", stackScopes.length, STACKS_CAP),
    cap("overlay", countOf((row) => row.scope === "overlay"), OVERLAY_CAP),
  ]
}

function cap(scope: string, count: number, limit: number): Assertion {
  return assertion("caps", scope, count <= limit ? PASS : FAIL, `${count}/${limit}`)
}

export function checkRuleOfTwo(ctx: SmokeContext): Assertion[] {
  return SOURCES.map((source) => {
    const rows = ctx.countedRows.filter((row) => row.source === source && !row.isCharterOrFloor)
    const failing: string[] = []
    const inGrace: string[] = []
    for (const row of rows) {
      const problem = ruleOfTwoProblem(row, ctx.keelHome)
      if (problem) (row.isInGrace(ctx.today) ? inGrace : failing).push(`${row.id}: ${problem}`)
    }
    const needsIncidents = source === KEEL_SOURCE && (failing.length > 0 || inGrace.length > 0)
    const note = needsIncidents ? incidentCandidatesNote(ctx.dataDir) : ""
    return rowsAssertion("rule-of-two", source, failing, inGrace, rows.length, note)
  })
}

function ruleOfTwoProblem(row: LedgerRow, keelHome: string): string {
  const refs = sortedByCodePoint(new Set(row.incidentRefs))
  const privateRefs = refs.filter((ref) => ref.startsWith(PRIVATE_REF_PREFIX))
  if (row.source === KEEL_SOURCE && privateRefs.length > 0) return "private refs belong only in the overlay ledger"
  const missing = refs.filter((ref) => !privateRefs.includes(ref) && !isFile(pyJoin(keelHome, ref)))
  if (missing.length > 0) return "missing incident files: " + missing.join(",")
  if (refs.length < MIN_INCIDENTS) return `${refs.length} of ${MIN_INCIDENTS} incident refs`
  return ""
}

function incidentCandidatesNote(dataDir: string): string {
  const projects = pyJoin(dataDir, "projects")
  const names: string[] = []
  for (const project of listDirectory(projects).filter((name) => !name.startsWith("."))) {
    for (const file of listDirectory(pyJoin(projects, project, "memory"))) {
      if (!file.startsWith(".") && file.startsWith("feedback_")) names.push(pyJoin(projects, project, "memory", file))
    }
  }
  if (names.length === 0) return ""
  return ", incident candidates (feedback memories): " + firstItems(sortedByCodePoint(names).map(pyBasename))
}

function listDirectory(path: string): string[] {
  try {
    return fs.readdirSync(path)
  } catch {
    return []
  }
}

export function checkMetrics(ctx: SmokeContext): Assertion[] {
  return SOURCES.map((source) => {
    const rows = ctx.countedRows.filter((row) => row.source === source)
    const failing: string[] = []
    const inGrace: string[] = []
    for (const row of rows) {
      const outcome = evaluateMetric(row, ctx.metricWindowStart, ctx.today)
      const note = `${row.id}: ${outcome.error ?? `0 items for ${row.metric}`}`
      if (outcome.status === FAIL) failing.push(note)
      else if (outcome.status === GRACE) inGrace.push(note)
    }
    return rowsAssertion("metrics", source, failing, inGrace, rows.length)
  })
}

function rowsAssertion(check: string, source: string, failing: string[], inGrace: string[], checked: number, note: string = ""): Assertion {
  const parts = [`${checked} rows checked`]
  if (failing.length > 0) parts.push("failing: " + failing.join("; "))
  if (inGrace.length > 0) parts.push("in grace: " + inGrace.join("; "))
  const status = failing.length > 0 ? FAIL : inGrace.length > 0 ? GRACE : PASS
  return assertion(check, source, status, parts.join(", ") + note)
}

export function checkExpiry(ctx: SmokeContext): Assertion[] {
  const expired = ctx.countedRows.filter((row) => isPastReview(row, ctx.today)).map((row) => row.id)
  if (expired.length === 0) return [assertion("expiry", "all", PASS, "no row past review_by")]
  return [assertion("expiry", "all", WARN, `past review_by: ${expired.join(", ")} (run measure/propose for demotion or extension proposals)`)]
}
