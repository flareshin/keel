import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { CHECKOUT, LEDGER_COLUMNS, TODAY, MeasureSandbox, readText } from "./helpers.ts"

const SEED_IDS = [
  "K1", "K2", "K3", "K4", "K5", "risk", "F-irreversible", "F-secrets", "F-attribution",
  "F-force-push", "F-hookskip", "F-mod-trust", "C-dispatch", "C-handoff", "C-isolation", "S-jdk", "C-review-command",
  "C-verbatim-fix",
]
const SEED_GRACE_UNTIL = "2026-12-10"
const STATUS_WITHOUT_EVIDENCE = TODAY <= SEED_GRACE_UNTIL ? "GRACE" : "FAIL"

describe("seed ledger", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
    fs.copyFileSync(path.join(CHECKOUT, "ledger.tsv"), path.join(box.keel, "ledger.tsv"))
  })
  afterEach(() => box.cleanup())

  function seedRow(rowId: string): Record<string, string> {
    const lines = readText(path.join(CHECKOUT, "ledger.tsv")).split("\n").filter((line) => line !== "")
    const rows = lines.slice(1).map((line) => Object.fromEntries(line.split("\t").map((cell, index) => [LEDGER_COLUMNS[index], cell])))
    return rows.find((row) => row["id"] === rowId) as Record<string, string>
  }

  it("seedLedger_hasTheExactHeaderAndSeedIds", () => {
    const lines = readText(path.join(CHECKOUT, "ledger.tsv")).split("\n").filter((line) => line !== "")
    assert.equal(lines[0], LEDGER_COLUMNS.join("\t"))
    assert.deepEqual(lines.slice(1).map((line) => line.split("\t")[0]), SEED_IDS)
    assert.ok(lines.every((line) => line.split("\t").length === LEDGER_COLUMNS.length))
  })

  it("seedLedger_passesFormatUniquenessAndCaps", () => {
    const [, result] = box.runJson("smoke", ["--json-only"])
    const relevant = result.assertions.filter((item: { check: string }) => ["ledger-format", "id-unique", "caps"].includes(item.check))
    assert.deepEqual(relevant.filter((item: { status: string }) => item.status !== "PASS"), [])
    assert.deepEqual(relevant.find((item: { scope: string; check: string }) => item.check === "caps" && item.scope === "core"), { check: "caps", scope: "core", status: "PASS", detail: "6/10" })
  })

  it("seedLedger_isGraceUntilItsGraceDate_forRuleOfTwoAndMetricsWithNoFiresYet", () => {
    const [, result] = box.runJson("smoke", ["--json-only"])
    const statuses = new Map<string, string>(result.assertions.map((item: { check: string; scope: string; status: string }) => [`${item.check}/${item.scope}`, item.status]))
    assert.equal(statuses.get("rule-of-two/keel"), STATUS_WITHOUT_EVIDENCE)
    assert.equal(statuses.get("metrics/keel"), STATUS_WITHOUT_EVIDENCE)
  })

  it("seedLedger_runsEveryRowMetric_withGraceStatusBeforeAnyFires", () => {
    const expectedExit = STATUS_WITHOUT_EVIDENCE === "GRACE" ? 0 : 1
    for (const rowId of SEED_IDS) {
      const [completed, result] = box.runJson("run", [rowId])
      assert.deepEqual([completed.status, result.status], [expectedExit, STATUS_WITHOUT_EVIDENCE], rowId)
    }
  })

  it("seedLedger_modTrustMetricCountsTheShippedCheck_whenTheLiveCheckoutHoldsIt", () => {
    const metric = seedRow("F-mod-trust")?.["metric"] as string
    const [repo, ref, file] = metric.slice("exists:".length).split(":") as [string, string, string]
    const live = path.join(box.env["HOME"] as string, repo.slice("~/".length))
    box.write(path.relative(box.root, path.join(live, file)), "shipped check\n")
    box.git(live, "init", "-q")
    box.commitAll(live)
    const [completed, result] = box.runJson("run", ["F-mod-trust"])
    assert.ok(fs.statSync(path.join(CHECKOUT, file)).isFile(), file)
    assert.deepEqual([repo.slice(0, 2), ref], ["~/", "HEAD"])
    assert.deepEqual([completed.status, result.status, result.count], [0, "PASS", 1])
  })
})
