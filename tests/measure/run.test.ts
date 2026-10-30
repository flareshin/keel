import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { addDays } from "../../measure/lib/measurekit/dates.ts"
import { FUTURE, NOW_TS, PAST, TODAY, MeasureSandbox, ledgerRow } from "./helpers.ts"
import type { LedgerRowValues } from "./helpers.ts"

describe("measure run", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
  })
  afterEach(() => box.cleanup())

  const givenKeelRows = (...rows: LedgerRowValues[]) => box.writeLedger("keel/ledger.tsv", rows)

  it("run_countsFiresInWindow_excludingErrorsAndOtherIds", () => {
    givenKeelRows(ledgerRow("C-demo"))
    box.fire("C-demo")
    box.fire("C-demo", NOW_TS, "pass")
    box.fire("C-demo", NOW_TS, "error")
    box.fire("C-other")
    box.fire("C-demo", addDays(TODAY, -90) + "T00:00:00Z")
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual([result.id, result.metric, result.count, result.status], ["C-demo", "fires:C-demo", 2, "PASS"])
  })

  it("run_countsNoFire_fromAProbeSession", () => {
    givenKeelRows(ledgerRow("C-demo"))
    box.fire("C-demo")
    box.appendLog("keel-fires.jsonl", { ts: NOW_TS, rule_id: "C-demo", hook: "ship-gate", outcome: "deny", session: "s1" })
    box.appendLog("keel-fires.jsonl", { ts: NOW_TS, rule_id: "C-demo", hook: "ship-gate", outcome: "deny", session: "0f8fad5b-d9cb-469f-a165-70867728950e" })
    const [, result] = box.runJson("run", ["C-demo"])
    assert.equal(result.count, 2)
  })

  it("run_countsNoFire_markedProcedural", () => {
    givenKeelRows(ledgerRow("C-demo"))
    box.fire("C-demo")
    box.appendLog("keel-fires.jsonl", { ts: NOW_TS, rule_id: "C-demo", hook: "git-guard", outcome: "deny", session: "-", kind: "procedural" })
    const [, result] = box.runJson("run", ["C-demo"])
    assert.equal(result.count, 1)
  })

  it("run_countsNoFire_whoseTimestampIsNotAString", () => {
    givenKeelRows(ledgerRow("C-demo", { grace_until: PAST }))
    box.appendLog("keel-fires.jsonl", { ts: null, rule_id: "C-demo", hook: "ship-gate", outcome: "deny", session: "-" })
    box.appendLog("keel-fires.jsonl", { ts: 20991231, rule_id: "C-demo", hook: "ship-gate", outcome: "deny", session: "-" })
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.count, result.status], [1, 0, "FAIL"])
  })

  it("run_skipsContractMissLines_becauseTheyRecordAPayloadChangeNotADecision", () => {
    givenKeelRows(ledgerRow("C-demo"))
    box.fire("C-demo")
    box.fire("C-demo", NOW_TS, "contract-miss")
    const [, result] = box.runJson("run", ["C-demo"])
    assert.equal(result.count, 1)
  })

  it("run_skipsWarnLines_becauseTheHookLetTheActionThroughWithoutADecision", () => {
    givenKeelRows(ledgerRow("C-demo", { grace_until: PAST }))
    box.fire("C-demo", NOW_TS, "warn")
    box.fire("C-demo", NOW_TS, "warn")
    let [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.count, result.status], [1, 0, "FAIL"])
    box.fire("C-demo", NOW_TS, "deny")
    box.fire("C-demo", NOW_TS, "pass")
    box.fire("C-demo", NOW_TS, "record")
    ;[completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.count, result.status], [0, 3, "PASS"])
  })

  it("run_includesOlderFires_whenSinceIsGiven", () => {
    givenKeelRows(ledgerRow("C-demo"))
    box.fire("C-demo", "2020-01-02T00:00:00Z")
    const [, result] = box.runJson("run", ["C-demo", "--since", "2020-01-01"])
    assert.equal(result.count, 1)
  })

  it("run_reportsGrace_whenZeroItemsBeforeGraceUntil", () => {
    givenKeelRows(ledgerRow("C-demo", { grace_until: FUTURE }))
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.count, result.status], [0, 0, "GRACE"])
  })

  it("run_failsWithExitOne_whenZeroItemsAfterGraceUntil", () => {
    givenKeelRows(ledgerRow("C-demo", { grace_until: PAST }))
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.status], [1, "FAIL"])
  })

  it("run_countsOnlyPassingEvals_forEvalsMetric", () => {
    givenKeelRows(ledgerRow("C-demo", { metric: "evals:demo" }))
    box.appendLog("keel-evals.jsonl", { ts: NOW_TS, eval_id: "demo", rule_id: "C-demo", case: "a", pass: true, model: "m" })
    box.appendLog("keel-evals.jsonl", { ts: NOW_TS, eval_id: "demo", rule_id: "C-demo", case: "b", pass: false, model: "m" })
    const [, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([result.count, result.status], [1, "PASS"])
  })

  it("run_usesOverlayRunner_whenKeelHasNone", () => {
    givenKeelRows(ledgerRow("C-demo", { metric: "run:demo-runner" }))
    box.write("overlay/measure/metrics/demo-runner", '#!/bin/bash\necho \'{"count": 2, "items": ["a", "b"]}\'\n', true)
    const [, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([result.count, result.items, result.status], [2, ["a", "b"], "PASS"])
  })

  it("run_failsWithError_whenTheRunnerCountIsABoolean", () => {
    givenKeelRows(ledgerRow("C-demo", { metric: "run:odd" }))
    box.write("keel/measure/metrics/odd", "#!/bin/bash\necho '{\"count\": true, \"items\": []}'\n", true)
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.status, result.count], [1, "FAIL", 0])
    assert.ok(result.error.includes('must print {"count": int'), result.error)
  })

  it("run_countsTheRunnerCount_whenItIsAnIntegralNumberInAnySpelling", () => {
    givenKeelRows(ledgerRow("C-demo", { metric: "run:odd" }))
    for (const [printed, count] of [["1.0", 1], ["12345678901234567890", 1.2345678901234567e19]] as const) {
      box.write("keel/measure/metrics/odd", `#!/bin/bash\necho '{"count": ${printed}, "items": []}'\n`, true)
      const [completed, result] = box.runJson("run", ["C-demo"])
      assert.deepEqual([completed.status, result.status, result.count], [0, "PASS", count])
    }
  })

  it("run_failsWithError_whenRunnerPrintsNoJson", () => {
    givenKeelRows(ledgerRow("C-demo", { metric: "run:broken", grace_until: FUTURE }))
    box.write("keel/measure/metrics/broken", "#!/bin/bash\necho not-json\n", true)
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.status], [1, "FAIL"])
    assert.ok(result.error.includes("did not print one JSON object"))
  })

  it("run_failsWithError_whenRunnerIsMissing", () => {
    givenKeelRows(ledgerRow("C-demo", { metric: "run:absent" }))
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.equal(completed.status, 1)
    assert.ok(result.error.includes("no runner"))
  })

  it("run_countsOneItem_whenExistsMetricFindsThePath", () => {
    const repo = path.join(box.root, "target")
    box.write("target/lint/rule.cfg", "rule\n")
    box.initRepo(repo, "https://example.invalid/acme/target.git")
    box.commitAll(repo)
    givenKeelRows(ledgerRow("C-demo", { layer: "repo", enforced_at: "repo:acme/target:lint/rule.cfg", metric: `exists:${repo}:HEAD:lint/rule.cfg` }))
    const [, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([result.count, result.items, result.status], [1, ["HEAD:lint/rule.cfg"], "PASS"])
  })

  it("run_failsExistsMetric_whenThePathIsMissing", () => {
    const repo = path.join(box.root, "target")
    box.write("target/README", "x\n")
    box.initRepo(repo)
    box.commitAll(repo)
    givenKeelRows(ledgerRow("C-demo", { metric: `exists:${repo}:HEAD:lint/rule.cfg` }))
    const [completed, result] = box.runJson("run", ["C-demo"])
    assert.deepEqual([completed.status, result.count, result.status], [1, 0, "FAIL"])
  })

  it("run_findsOverlayRows_fromTheOverlayLedger", () => {
    givenKeelRows(ledgerRow("C-demo"))
    box.writeLedger("overlay/ledger.tsv", [ledgerRow("O-demo", { scope: "overlay", incidents: "private:a,private:b" })])
    box.fire("O-demo")
    const [, result] = box.runJson("run", ["O-demo"])
    assert.deepEqual([result.id, result.status], ["O-demo", "PASS"])
  })

  it("run_expandsTilde_whenDataAndOverlayDirsStartWithTilde", () => {
    const home = box.env["HOME"] as string
    givenKeelRows(ledgerRow("C-demo"))
    box.writeLedger("home/ov/ledger.tsv", [ledgerRow("O-demo", { scope: "overlay", incidents: "private:a,private:b" })])
    const fires = path.join(home, "kd", "logs", "keel-fires.jsonl")
    fs.mkdirSync(path.dirname(fires), { recursive: true })
    fs.writeFileSync(fires, `{"ts": "${NOW_TS}", "rule_id": "O-demo", "hook": "ship-gate", "outcome": "deny", "session": "-"}\n`)
    box.env["KEEL_DATA_DIR"] = "~/kd"
    box.env["KEEL_OVERLAY_DIR"] = "~/ov"
    const [completed, result] = box.runJson("run", ["O-demo"])
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual([result.count, result.status], [1, "PASS"])
  })

  it("run_exitsTwo_whenIdIsUnknown", () => {
    givenKeelRows(ledgerRow("C-demo"))
    const completed = box.runMeasure("run", ["C-nope"])
    assert.equal(completed.status, 2)
    assert.equal(completed.stdout, "")
  })

  it("run_exitsTwo_whenSinceIsNotADate", () => {
    givenKeelRows(ledgerRow("C-demo"))
    const completed = box.runMeasure("run", ["C-demo", "--since", "yesterday"])
    assert.equal(completed.status, 2)
  })

  it("run_exitsTwo_whenSinceIsAnImpossibleDate", () => {
    givenKeelRows(ledgerRow("C-demo"))
    const completed = box.runMeasure("run", ["C-demo", "--since", "2026-02-30"])
    assert.equal(completed.status, 2)
  })
})
