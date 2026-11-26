import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { classifyLandings } from "../../measure/lib/measurekit/ungated_landings.ts"
import type { JsonObject } from "../../measure/lib/measurekit/json.ts"
import { MeasureSandbox, charterRow } from "./helpers.ts"

const REPO = "example/keel"
const BEFORE_COMMITS = "2025-12-01"
const AFTER_COMMITS = "2026-02-01"
const SESSION = "26210b10-e5c5-48c6-ab0f-8f8e89d781ae"

describe("ungated_landings", () => {
  let box: MeasureSandbox
  let fires: JsonObject[]

  beforeEach(() => {
    box = new MeasureSandbox()
    box.initRepo(box.keel)
    fires = []
  })
  afterEach(() => box.cleanup())

  function commit(name: string): string {
    box.write(`keel/${name}.txt`, name + "\n")
    return box.commitAll(box.keel, name)
  }

  function land(tip: string): void {
    box.git(box.keel, "update-ref", "-m", "update by push", "refs/remotes/origin/main", tip)
  }

  function mergeBranch(branch: string): string {
    box.git(box.keel, "checkout", "-q", "main")
    box.git(box.keel, "merge", "-q", "--no-ff", "--no-verify", "-m", "Merge " + branch, branch)
    return box.git(box.keel, "rev-parse", "HEAD").trim()
  }

  function fire(head: string, outcome: string, extra: JsonObject = {}): void {
    const judged: JsonObject = outcome === "pass" ? { risk: "standard" } : {}
    fires.push({ hook: "ship-gate", repo: REPO, head, outcome, rule_id: "K1", session: SESSION, ...judged, ...extra })
  }

  it("classifyLandings_sortsEachLandedCommitByTheShipGateFiresOfItsOriginUpdate", () => {
    land(commit("base"))
    commit("d1")
    const d2 = commit("d2")
    land(d2)
    fire(d2, "pass")
    const d3 = commit("d3")
    land(d3)
    box.git(box.keel, "checkout", "-q", "-b", "f")
    const f1 = commit("f1")
    const f2 = commit("f2")
    fire(f1, "deny")
    fire(f2, "deny")
    fire(f2, "pass")
    land(mergeBranch("f"))
    box.git(box.keel, "checkout", "-q", "-b", "g")
    const g1 = commit("g1")
    fire(g1, "pass")
    const g2 = commit("g2")
    land(mergeBranch("g"))
    box.git(box.keel, "checkout", "-q", "main")
    const e1 = commit("e1")
    fire(e1, "deny")
    land(e1)
    const w1 = commit("w1")
    fire(w1, "warn")
    land(w1)
    box.git(box.keel, "checkout", "-q", "-b", "h")
    commit("h1")
    const m3 = mergeBranch("h")
    fire(m3, "pass")
    land(m3)

    const result = classifyLandings(box.keel, "main", REPO, fires, BEFORE_COMMITS)

    assert.deepEqual(
      { ...result, examples: undefined },
      { updates: 7, commits: 10, covered: 6, after_pass: 1, denied_only: 1, warned_only: 1, no_fire: 1, examples: undefined },
    )
    assert.deepEqual(result.examples, {
      after_pass: [g2.slice(0, 12)], denied_only: [e1.slice(0, 12)], warned_only: [w1.slice(0, 12)], no_fire: [d3.slice(0, 12)],
    })
  })

  it("classifyLandings_judgesEachCommitByTheFiresWhoseHeadReachesIt_whenOneUpdateCarriesTwoBranches", () => {
    land(commit("base"))
    box.git(box.keel, "checkout", "-q", "-b", "a")
    const a1 = commit("a1")
    fire(a1, "deny")
    mergeBranch("a")
    box.git(box.keel, "checkout", "-q", "-b", "b")
    const b1 = commit("b1")
    land(mergeBranch("b"))

    const result = classifyLandings(box.keel, "main", REPO, fires, BEFORE_COMMITS)

    assert.deepEqual(result.examples, { denied_only: [a1.slice(0, 12)], no_fire: [b1.slice(0, 12)] })
  })

  it("classifyLandings_ignoresAPassThatJudgedNothing_whenTheHeadWasDenied", () => {
    land(commit("base"))
    const d1 = commit("d1")
    fire(d1, "deny", { risk: "heavy" })
    fires.push({ hook: "ship-gate", repo: REPO, head: d1, outcome: "pass", rule_id: "K1", session: SESSION })
    land(d1)

    const result = classifyLandings(box.keel, "main", REPO, fires, BEFORE_COMMITS)

    assert.equal(result.covered, 0)
    assert.equal(result.denied_only, 1)
  })

  it("classifyLandings_ignoresFiresOfAnotherRepoAndOfSyntheticSessions", () => {
    land(commit("base"))
    const d1 = commit("d1")
    land(d1)
    fire(d1, "pass", { repo: "example/other" })
    fire(d1, "pass", { session: "test-session" })
    fire(d1, "pass", { hook: "git-guard" })
    fires.push({ hook: "ship-gate", head: d1, outcome: "pass", session: SESSION })

    const result = classifyLandings(box.keel, "main", REPO, fires, BEFORE_COMMITS)

    assert.equal(result.no_fire, 1)
    assert.equal(result.covered, 0)
  })

  it("classifyLandings_countsEachCommitOnce_whenTheOriginRefMovesBackAndForth", () => {
    const base = commit("base")
    const d1 = commit("d1")
    land(base)
    land(d1)
    land(base)
    land(d1)

    const result = classifyLandings(box.keel, "main", REPO, fires, BEFORE_COMMITS)

    assert.equal(result.updates, 3)
    assert.equal(result.commits, 1)
  })

  it("classifyLandings_keepsFiveExamplesPerBucket", () => {
    land(commit("base"))
    for (const name of ["d1", "d2", "d3", "d4", "d5"]) commit(name)
    land(commit("d6"))

    const result = classifyLandings(box.keel, "main", REPO, fires, BEFORE_COMMITS)

    assert.equal(result.no_fire, 6)
    assert.equal(result.examples.no_fire!.length, 5)
  })

  it("classifyLandings_countsAnOriginUpdateOnTheWindowStartDay", () => {
    land(commit("base"))
    land(commit("d1"))

    const result = classifyLandings(box.keel, "main", REPO, fires, "2026-01-01")

    assert.equal(result.updates, 1)
  })

  it("classifyLandings_countsOnlyOriginUpdatesInsideTheWindow", () => {
    land(commit("base"))
    land(commit("d1"))

    const result = classifyLandings(box.keel, "main", REPO, fires, AFTER_COMMITS)

    assert.equal(result.updates, 0)
    assert.equal(result.commits, 0)
  })
})

describe("weekly ungated_landings", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
    box.initRepo(box.keel)
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
  })
  afterEach(() => box.cleanup())

  it("weekly_reportsAnErrorPerCheckout_whenItsRepoIsNotGated", () => {
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.ungated_landings, { "example/keel": { error: "example/keel is not a gated repo in gated-repos.tsv" } })
  })

  it("weekly_reportsAnError_andStillPrintsTheReport_whenGatedReposTsvIsMalformed", () => {
    box.write("overlay/gated-repos.tsv", "origin\tgate\nexample/keel\tcode\n")
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.match(report.ungated_landings.error, /gated-repos.tsv: header must be/)
  })

  it("weekly_reportsAnError_andStillPrintsTheReport_whenTheFiresLogIsNotUtf8", () => {
    fs.mkdirSync(path.join(box.data, "logs"), { recursive: true })
    fs.writeFileSync(path.join(box.data, "logs", "keel-fires.jsonl"), Buffer.from([0xff, 0x0a]))
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.match(report.ungated_landings.error, /^unreadable keel-fires.jsonl: /)
  })

  it("weekly_reportsAnError_andStillPrintsTheReport_whenTheFiresLogIsADirectory", () => {
    fs.mkdirSync(path.join(box.data, "logs", "keel-fires.jsonl"), { recursive: true })
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.match(report.ungated_landings.error, /^unreadable keel-fires.jsonl: /)
  })

  it("weekly_reportsAnError_andStillPrintsTheReport_whenGatedReposTsvIsNotUtf8", () => {
    fs.mkdirSync(path.join(box.root, "overlay"), { recursive: true })
    fs.writeFileSync(path.join(box.root, "overlay", "gated-repos.tsv"), Buffer.from([0xff, 0x0a]))
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(typeof report.ungated_landings.error, "string")
  })

  it("weekly_reportsAnError_andStillPrintsTheReport_whenGatedReposTsvIsUnreadable", () => {
    fs.chmodSync(box.write("overlay/gated-repos.tsv", "origin\tgate\tintegration_base\trisk_rules\ttests\n"), 0o000)
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(typeof report.ungated_landings.error, "string")
  })

  it("weekly_reportsAnError_whenTheGatedRepoHasNoOriginRef", () => {
    box.write("overlay/gated-repos.tsv", "origin\tgate\tintegration_base\trisk_rules\ttests\nexample/keel\tcode\tmain\t-\tnone\n")
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.deepEqual(report.ungated_landings, { "example/keel": { error: "no reflog for refs/remotes/origin/main" } })
  })
})
