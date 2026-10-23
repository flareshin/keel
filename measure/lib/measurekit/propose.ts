import { addDays } from "./dates.ts"
import { evaluateMetric } from "./metrics.ts"
import { parseDate } from "./ledger.ts"
import type { LedgerRow } from "./ledger.ts"

const NEXT_LOWER_LAYER: Record<string, string> = { hook: "skill", skill: "prose", prose: "retired" }
const REVIEW_EXTENSION_DAYS = 60
const REPO_LAYER = "repo"
const ACTIVE = "active"

export interface Proposal {
  id: string
  action: string
  from: string
  to: string
  reason: string
}

export function buildExpiryProposals(rows: LedgerRow[], since: string, today: string): Proposal[] {
  return rows.filter((row) => row.status === ACTIVE && isPastReview(row, today)).map((row) => proposeFromMetric(row, since, today))
}

function proposeFromMetric(row: LedgerRow, since: string, today: string): Proposal {
  const result = evaluateMetric(row, since, today)
  if (result.error !== undefined) return proposal(row, "recheck", row.layer, row.layer, `metric errored, nothing counted: ${result.error}`)
  return proposeForExpiredRow(row, result.count, today)
}

export function isPastReview(row: LedgerRow, today: string): boolean {
  const reviewBy = parseDate(row.reviewBy)
  return reviewBy !== null && today > reviewBy
}

export function proposeForExpiredRow(row: LedgerRow, count: number, today: string): Proposal {
  if (row.layer === REPO_LAYER && count === 0) {
    return proposal(row, "recheck", REPO_LAYER, REPO_LAYER, "repo rule's existence check failed; re-check where it lives")
  }
  if (row.layer === REPO_LAYER || count > 0) {
    return proposal(row, "extend", row.reviewBy, addDays(today, REVIEW_EXTENSION_DAYS), `metric counted ${count} item(s) in the window`)
  }
  const lower = NEXT_LOWER_LAYER[row.layer] ?? row.layer
  const action = lower === "retired" ? "retire" : "demote"
  return proposal(row, action, row.layer, lower, "metric counted 0 items in the window past review_by")
}

export function buildRereviewProposals(rows: LedgerRow[], model: string): Proposal[] {
  const reason = `model upgrade to ${model}: re-run this row's evals before keeping it`
  return rows.filter((row) => row.status === ACTIVE).map((row) => proposal(row, "rereview", row.layer, row.layer, reason))
}

function proposal(row: LedgerRow, action: string, from: string, to: string, reason: string): Proposal {
  return { id: row.id, action, from, to, reason }
}
