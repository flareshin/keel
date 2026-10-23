import { dataLines, readTsvLines, TsvError } from "./datafiles.ts"
import fs from "node:fs"
import path from "node:path"

import { parseIsoDate } from "./dates.ts"
import { isFile } from "./files.ts"

export const KEEL_SOURCE = "keel"
export const OVERLAY_SOURCE = "overlay"
export const EMPTY = "-"

const LAYERS = ["repo", "hook", "skill", "prose"]
const TYPES = ["knowledge", "incentive", "floor"]
const STATUSES = ["active", "proposed-demote", "retired"]
export const RETIRED = "retired"
const CHARTER_SCOPE = "charter"
const STACK_SCOPE_PREFIX = "stack:"
const FLOOR_TYPE = "floor"

const ID_PATTERN = /^(K[1-7]|risk|[CSOF]-[a-z0-9-]+)$/
const SCOPE_PATTERN = /^(charter|core|overlay|stack:[a-z0-9-]+)$/
const ENFORCED_AT_PATTERN = /^(hook|skill):[a-z0-9-]+$|^prose:\S+$|^repo:[^:\s/]+\/[^:\s/]+:\S+$/
const METRIC_PATTERN = /^(fires|evals):\S+$|^run:[A-Za-z0-9._-]+$|^exists:[^:]+:[^:]+:.+$/
const INCIDENT_PATTERN = /^docs\/incidents\/[A-Za-z0-9._-]+\.md$|^private:[A-Za-z0-9._-]+$/
const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export const COLUMNS = [
  "id", "scope", "type", "statement", "layer", "enforced_at", "why_not_stronger",
  "justification", "incidents", "metric", "review_by", "grace_until", "status",
] as const

type RowCells = [string, string, string, string, string, string, string, string, string, string, string, string, string]

export class StackNameError extends Error {}

export class LedgerRow {
  readonly source: string
  readonly line: number
  readonly id: string
  readonly scope: string
  readonly type: string
  readonly statement: string
  readonly layer: string
  readonly enforcedAt: string
  readonly whyNotStronger: string
  readonly justification: string
  readonly incidents: string
  readonly metric: string
  readonly reviewBy: string
  readonly graceUntil: string
  readonly status: string

  constructor(source: string, line: number, cells: string[]) {
    const [id, scope, type, statement, layer, enforcedAt, whyNotStronger, justification, incidents, metric, reviewBy, graceUntil, status] = cells as RowCells
    this.source = source
    this.line = line
    this.id = id
    this.scope = scope
    this.type = type
    this.statement = statement
    this.layer = layer
    this.enforcedAt = enforcedAt
    this.whyNotStronger = whyNotStronger
    this.justification = justification
    this.incidents = incidents
    this.metric = metric
    this.reviewBy = reviewBy
    this.graceUntil = graceUntil
    this.status = status
  }

  get isCharterOrFloor(): boolean {
    return this.scope === CHARTER_SCOPE || this.type === FLOOR_TYPE
  }

  get hookName(): string | null {
    if (this.layer !== "hook") return null
    const colon = this.enforcedAt.indexOf(":")
    return colon < 0 ? "" : this.enforcedAt.slice(colon + 1)
  }

  get incidentRefs(): string[] {
    if (this.incidents === EMPTY) return []
    return this.incidents.split(",").map((ref) => ref.trim()).filter((ref) => ref !== "")
  }

  isInGrace(today: string): boolean {
    const graceUntil = parseDate(this.graceUntil)
    return graceUntil !== null && today <= graceUntil
  }
}

export interface Ledger {
  source: string
  path: string
  present: boolean
  rows: LedgerRow[]
  problems: string[]
}

export function loadLedgersFrom(keelHome: string, overlayDir: string): Ledger[] {
  return [
    loadLedger(path.join(keelHome, "ledger.tsv"), KEEL_SOURCE),
    loadLedger(path.join(overlayDir, "ledger.tsv"), OVERLAY_SOURCE),
  ]
}

export function loadLedger(ledgerPath: string, source: string): Ledger {
  const ledger: Ledger = { source, path: ledgerPath, present: fs.existsSync(ledgerPath), rows: [], problems: [] }
  if (!ledger.present) return ledger
  let lines: [number, string[]][]
  try {
    lines = readTsvLines(ledgerPath, COLUMNS)
  } catch (error) {
    if (error instanceof TsvError) {
      ledger.problems.push(error.message)
      return ledger
    }
    throw error
  }
  for (const [number, cells] of lines) {
    if (cells.length !== COLUMNS.length) {
      ledger.problems.push(`line ${number}: expected ${COLUMNS.length} columns, found ${cells.length}`)
      continue
    }
    ledger.rows.push(new LedgerRow(source, number, cells))
  }
  return ledger
}

export function allRows(ledgers: Ledger[]): LedgerRow[] {
  return ledgers.flatMap((ledger) => ledger.rows)
}

export function countedRows(ledgers: Ledger[]): LedgerRow[] {
  return allRows(ledgers).filter((row) => row.status !== RETIRED)
}

export function hookRowsInForce(ledgers: Ledger[], activeStacks: string[]): LedgerRow[] {
  return countedRows(ledgers).filter(
    (row) => row.hookName && (!row.scope.startsWith(STACK_SCOPE_PREFIX) || activeStacks.includes(row.scope.slice(STACK_SCOPE_PREFIX.length))),
  )
}

export function activeStackNames(overlayDir: string): string[] {
  const stacksFile = path.join(overlayDir, "stacks.txt")
  if (!isFile(stacksFile)) return []
  const names = dataLines(stacksFile).map(([, line]) => line.trim())
  for (const name of names) {
    if (!STACK_NAME_PATTERN.test(name)) throw new StackNameError(`${stacksFile}: invalid stack name ${JSON.stringify(name)}`)
  }
  return names
}

export function parseDate(value: string): string | null {
  return parseIsoDate(value)
}

export function validateRow(row: LedgerRow): string[] {
  const scopeKnown = SCOPE_PATTERN.test(row.scope)
  const enforcedAtKnown = ENFORCED_AT_PATTERN.test(row.enforcedAt)
  const badRefs = row.incidentRefs.filter((ref) => !INCIDENT_PATTERN.test(ref))
  const checks: [boolean, string][] = [
    [!ID_PATTERN.test(row.id), `id does not match ${ID_PATTERN.source}`],
    [!scopeKnown, `unknown scope ${JSON.stringify(row.scope)}`],
    [scopeKnown && row.scope !== expectedScope(row), `id prefix needs scope ${expectedScope(row)}`],
    [(row.scope === "overlay") !== (row.source === OVERLAY_SOURCE), "overlay rows live only in the overlay ledger, and it holds only overlay rows"],
    [!TYPES.includes(row.type), `unknown type ${JSON.stringify(row.type)}`],
    [row.id.startsWith("F-") !== (row.type === FLOOR_TYPE), "F- ids and type=floor go together"],
    [row.statement === EMPTY || row.statement.trim() === "", "statement is empty"],
    [!LAYERS.includes(row.layer), `unknown layer ${JSON.stringify(row.layer)}`],
    [!enforcedAtKnown, `enforced_at ${JSON.stringify(row.enforcedAt)} is not hook:/skill:/prose:/repo:<owner/repo>:<path>`],
    [enforcedAtKnown && row.enforcedAt.split(":", 1)[0] !== row.layer, `enforced_at kind differs from layer ${JSON.stringify(row.layer)}`],
    [["skill", "prose"].includes(row.layer) && row.whyNotStronger === EMPTY, `layer ${row.layer} needs why_not_stronger`],
    [row.isCharterOrFloor && row.justification === EMPTY, "charter and floor rows need a justification"],
    [badRefs.length > 0, `bad incident refs: ${badRefs.join(",")}`],
    [row.metric !== EMPTY && !METRIC_PATTERN.test(row.metric), `metric ${JSON.stringify(row.metric)} is not fires:/evals:/run:/exists:`],
    [row.reviewBy !== EMPTY && parseDate(row.reviewBy) === null, `review_by ${JSON.stringify(row.reviewBy)} is not YYYY-MM-DD`],
    [row.graceUntil !== EMPTY && parseDate(row.graceUntil) === null, `grace_until ${JSON.stringify(row.graceUntil)} is not YYYY-MM-DD`],
    [row.isCharterOrFloor && row.reviewBy !== EMPTY, "charter and floor rows use review_by '-'"],
    [!row.isCharterOrFloor && row.reviewBy === EMPTY, "review_by is required"],
    [!STATUSES.includes(row.status), `unknown status ${JSON.stringify(row.status)}`],
  ]
  return checks.filter(([violated]) => violated).map(([, message]) => `${row.id} (line ${row.line}): ${message}`)
}

function expectedScope(row: LedgerRow): string {
  if (row.id.startsWith("K")) return CHARTER_SCOPE
  if (row.id.startsWith("S-")) return row.scope.startsWith("stack:") ? row.scope : "stack:<name>"
  if (row.id.startsWith("O-")) return "overlay"
  return "core"
}
