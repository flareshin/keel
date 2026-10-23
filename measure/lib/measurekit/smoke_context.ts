import fs from "node:fs"

import * as env from "./env.ts"
import { allRows, countedRows, loadLedgersFrom } from "./ledger.ts"
import type { Ledger, LedgerRow } from "./ledger.ts"
import { DEFAULT_WINDOW_DAYS } from "./metrics.ts"
import { addDays, todayLocal } from "./pydate.ts"
import { isDir, isFile, pyJoin } from "./pypath.ts"
import { sortedByCodePoint } from "./pystr.ts"

export interface Assertion {
  check: string
  scope: string
  status: string
  detail: string
}

export class SmokeContext {
  readonly keelHome: string
  readonly overlayDir: string
  readonly dataDir: string
  readonly today: string
  readonly ledgers: Ledger[]
  readonly candidate: boolean

  constructor(keelHome: string, overlayDir: string, dataDir: string, today: string, ledgers: Ledger[], candidate: boolean = false) {
    this.keelHome = keelHome
    this.overlayDir = overlayDir
    this.dataDir = dataDir
    this.today = today
    this.ledgers = ledgers
    this.candidate = candidate
  }

  static fromEnvironment(candidate: boolean = false): SmokeContext {
    const keelHome = env.keelHome()
    const overlayDir = env.overlayDir()
    return new SmokeContext(keelHome, overlayDir, env.dataDir(), todayLocal(), loadLedgersFrom(keelHome, overlayDir), candidate)
  }

  get rows(): LedgerRow[] {
    return allRows(this.ledgers)
  }

  get countedRows(): LedgerRow[] {
    return countedRows(this.ledgers)
  }

  get metricWindowStart(): string {
    return addDays(this.today, -DEFAULT_WINDOW_DAYS)
  }

  memoryIndexes(): string[] {
    const projects = pyJoin(this.dataDir, "projects")
    if (!isDir(projects)) return []
    const candidates = sortedByCodePoint(fs.readdirSync(projects)).map((name) => pyJoin(projects, name, "memory", "MEMORY.md"))
    return candidates.filter(isFile)
  }
}

export function assertion(check: string, scope: string, status: string, detail: string): Assertion {
  return { check, scope, status, detail }
}

export function firstItems(items: string[], limit: number = 5): string {
  const shown = items.slice(0, limit).join("; ")
  return items.length <= limit ? shown : `${shown}; ... (${items.length - limit} more)`
}
