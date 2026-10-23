import assert from "node:assert/strict"

import { MeasureSandbox } from "./helpers.ts"
import type { Completed, LedgerRowValues } from "./helpers.ts"

export interface SmokeItem {
  check: string
  scope: string
  status: string
  detail: string
}

export class SmokeHarness {
  readonly box: MeasureSandbox

  constructor() {
    this.box = new MeasureSandbox()
    this.box.seedCleanKeel()
  }

  cleanup(): void {
    this.box.cleanup()
  }

  runSmoke(): [Completed, { run_id: string; ok: boolean; count: number; cap: number; assertions: SmokeItem[] }] {
    const [completed, result] = this.box.runJson("smoke", ["--json-only"])
    assert.notEqual(result, null, completed.stderr)
    return [completed, result]
  }

  assertion(check: string, scope: string): SmokeItem {
    const [, result] = this.runSmoke()
    const matches = result.assertions.filter((item) => item.check === check && item.scope === scope)
    assert.equal(matches.length, 1, JSON.stringify(result.assertions))
    return matches[0] as SmokeItem
  }

  assertStatus(check: string, scope: string, status: string, detailPart: string = ""): SmokeItem {
    const item = this.assertion(check, scope)
    assert.equal(item.status, status, JSON.stringify(item))
    assert.ok(item.detail.includes(detailPart), `${JSON.stringify(item.detail)} lacks ${JSON.stringify(detailPart)}`)
    return item
  }

  keelRows(...rows: LedgerRowValues[]): void {
    this.box.writeLedger("keel/ledger.tsv", rows)
  }
}
