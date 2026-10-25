import fs from "node:fs"
import path from "node:path"

import { addDays, todayLocal } from "./dates.ts"
import * as env from "./env.ts"
import { isDir, isFile } from "./files.ts"
import { allRows, countedRows, loadLedgersFrom } from "./ledger.ts"
import type { Ledger, LedgerRow } from "./ledger.ts"
import { DEFAULT_WINDOW_DAYS, runRunnersConcurrently } from "./metrics.ts"
import type { FinishedRunners } from "./metrics.ts"

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
  finishedRunners: FinishedRunners = new Map()

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

  async runMetricRunners(): Promise<void> {
    this.finishedRunners = await runRunnersConcurrently(this.countedRows, this.metricWindowStart)
  }

  memoryIndexes(): string[] {
    const projects = path.join(this.dataDir, "projects")
    if (!isDir(projects)) return []
    const candidates = fs.readdirSync(projects).sort().map((name) => path.join(projects, name, "memory", "MEMORY.md"))
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
