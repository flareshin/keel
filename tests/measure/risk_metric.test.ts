import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import path from "node:path"

import { addDays } from "../../measure/lib/measurekit/dates.ts"
import { isExecutable } from "../../measure/lib/measurekit/files.ts"
import { CHECKOUT, FUTURE, MeasureSandbox, TODAY, ledgerRow } from "./helpers.ts"

const RUNNER = "measure/metrics/risk"
const REPO = "example/app"
const SESSION = "11111111-2222-3333-4444-555555555555"
const daysAgo = (days: number, time: string = "09:00:00Z"): string => `${addDays(TODAY, -days)}T${time}`
const OLD_SHIP_TS = daysAgo(30)
const RECENT_SHIP_TS = daysAgo(3)

interface PassFields {
  head?: string | null
  risk?: string | null
  rootRunId?: string | null
  ts?: string
  repo?: string
  session?: string
  outcome?: string
  kind?: string
}

describe("risk runner", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
    box.linkShippedRunners()
    box.writeLedger("keel/ledger.tsv", [ledgerRow("risk", { metric: "run:risk", grace_until: FUTURE })])
  })
  afterEach(() => box.cleanup())

  const givenPass = (fields: PassFields = {}): void => {
    const record: Record<string, unknown> = {
      ts: fields.ts ?? RECENT_SHIP_TS, rule_id: "risk", hook: "ship-gate", outcome: fields.outcome ?? "pass",
      repo: fields.repo ?? REPO, session: fields.session ?? SESSION,
    }
    if (fields.head !== null) record["head"] = fields.head ?? "a".repeat(40)
    if (fields.risk !== null) record["risk"] = fields.risk ?? "light"
    if (fields.rootRunId !== null) record["root_run_id"] = fields.rootRunId ?? "rv-a"
    if (fields.kind !== undefined) record["kind"] = fields.kind
    box.appendLog("keel-fires.jsonl", record)
  }

  const givenReview = (evidenceId: string, runId: string, fields: { createdAt?: string; base?: string | null; repoRoot?: string; rootRunId?: string } = {}): void => {
    box.write(`data/state/keel/evidence/review/${REPO.replace("/", "__")}/${evidenceId}.json`, JSON.stringify({
      evidence_id: evidenceId, run_id: runId, root_run_id: fields.rootRunId ?? runId, repo: REPO, since: null,
      created_at: fields.createdAt ?? daysAgo(3, "08:00:00Z"), expires_at: daysAgo(-11), verdict: "PASS",
      review_base: fields.base === undefined ? "0".repeat(40) : fields.base, repo_root: fields.repoRoot ?? path.join(box.root, "missing"),
    }))
  }

  const givenApproval = (evidenceId: string, rootRunId: string, createdAt: string, headReview: string): void => {
    box.write(`data/state/keel/evidence/approval/${evidenceId}.json`, JSON.stringify({
      evidence_id: evidenceId, kind: "approval", root_run_id: rootRunId, created_at: createdAt, expires_at: daysAgo(-11), heads: { [REPO]: headReview },
    }))
  }

  const commitAt = (repo: string, when: string, message: string, file: string, lines: string[]): string => {
    box.write(path.relative(box.root, path.join(repo, file)), lines.join("\n") + "\n")
    const dated = { ...box.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
    for (const args of [["add", "-A"], ["commit", "-q", "--no-verify", "-m", message]]) {
      const completed = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: dated })
      assert.equal(completed.status, 0, completed.stderr)
    }
    return box.git(repo, "rev-parse", "HEAD").trim()
  }

  const shipRepo = (): { repo: string; base: string; head: string } => {
    const repo = path.dirname(box.write("app/.keep", ""))
    box.initRepo(repo)
    const base = commitAt(repo, daysAgo(31), "Start", "app.ts", ["start"])
    const head = commitAt(repo, daysAgo(30, "08:00:00Z"), "Add the four lines", "app.ts", ["start", "one", "two", "three", "four"])
    commitAt(repo, daysAgo(25), "Fix the second line", "app.ts", ["start", "one", "TWO", "three", "four"])
    commitAt(repo, daysAgo(24), "refactor: wrap the third line", "app.ts", ["start", "one", "TWO", "(three)", "four"])
    commitAt(repo, daysAgo(10), "Change the fourth line after the horizon", "app.ts", ["start", "one", "TWO", "(three)", "FOUR"])
    box.git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    box.git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    return { repo, base, head }
  }

  const runMetric = () => {
    const [completed, result] = box.runJson("run", ["risk"])
    assert.ok(completed.status === 0 || completed.status === 1, completed.stderr)
    return result
  }

  const itemFor = (result: { items: { class: string }[] }, riskClass: string) => result.items.find((item) => item.class === riskClass) as Record<string, any>

  it("runnerInThisCheckout_isExecutable_soFindRunnerResolvesIt", () => {
    assert.ok(isExecutable(path.join(CHECKOUT, RUNNER)))
  })

  it("passLines_countOneShipPerRepoAndHead_listClassesInRiskOrder_andNameWhatHasNoSource", () => {
    givenPass({ risk: "standard", head: "b".repeat(40) })
    givenPass({ risk: "light" })
    givenPass({ risk: "light" })
    givenPass({ risk: null, head: "c".repeat(40) })
    const result = runMetric()
    assert.deepEqual([result.status, result.count], ["PASS", 2])
    assert.deepEqual(result.items.map((item: { class: string; ships: number }) => [item.class, item.ships]), [["light", 1], ["standard", 1], ["unclassified", 1]])
    assert.deepEqual([itemFor(result, "light")["escaped_defects"], itemFor(result, "light")["baseline"]], ["no source", "deferred"])
  })

  it("denyLines_proceduralLines_probeSessions_andLinesBeforeTheWindow_areNotShips", () => {
    givenPass({ outcome: "deny" })
    givenPass({ kind: "procedural", head: "b".repeat(40) })
    givenPass({ session: "probe-1", head: "c".repeat(40) })
    givenPass({ ts: daysAgo(90), head: "d".repeat(40) })
    const result = runMetric()
    assert.deepEqual([result.count, result.items, result.status], [0, [], "GRACE"])
  })

  it("reviewToApproval_usesTheFirstApprovalOfTheRun_andTheMedianOfTheApprovedShips", () => {
    givenPass({ rootRunId: "rv-a", head: "a".repeat(40) })
    givenPass({ rootRunId: "rv-b", head: "b".repeat(40) })
    givenPass({ rootRunId: "rv-c", head: "c".repeat(40) })
    givenReview("review-a", "rv-a", { createdAt: daysAgo(3, "08:00:00Z") })
    givenReview("review-b", "rv-b", { createdAt: daysAgo(3, "08:00:00Z") })
    givenApproval("approval-a2", "rv-a", daysAgo(3, "09:00:00Z"), "review-a")
    givenApproval("approval-a1", "rv-a", daysAgo(3, "08:10:00Z"), "review-a")
    givenApproval("approval-b", "rv-b", daysAgo(3, "08:30:00Z"), "review-b")
    const result = runMetric()
    assert.deepEqual(itemFor(result, "light")["review_to_approval"], { approved_ships: 2, without_approval: 1, median_minutes: 20 })
  })

  it("rework_countsShippedLinesChangedWithinFourteenDays_skippingRefactorOnlyCommitsAndLaterChanges", () => {
    const { repo, base, head } = shipRepo()
    givenPass({ head, ts: OLD_SHIP_TS })
    givenReview("review-a", "rv-a", { base, repoRoot: repo })
    const result = runMetric()
    assert.deepEqual(itemFor(result, "light")["rework"], {
      decided_ships: 1, pending_ships: 0, not_computable: {}, shipped_lines: 4, reworked_lines: 1, rate_percent: 25,
    })
  })

  it("rework_ofAShipYoungerThanFourteenDays_isPending_notZero", () => {
    const { repo, base, head } = shipRepo()
    givenPass({ head, ts: RECENT_SHIP_TS })
    givenReview("review-a", "rv-a", { base, repoRoot: repo })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.pending_ships, rework.rate_percent], [0, 1, null])
  })

  it("rework_namesWhyEachOldShipCannotBeComputed", () => {
    const { repo, base } = shipRepo()
    givenPass({ ts: OLD_SHIP_TS, head: null })
    givenPass({ ts: OLD_SHIP_TS, head: "b".repeat(40), rootRunId: null })
    givenPass({ ts: OLD_SHIP_TS, head: "c".repeat(40), rootRunId: "rv-unreviewed" })
    givenPass({ ts: OLD_SHIP_TS, head: "d".repeat(40), rootRunId: "rv-nobase" })
    givenPass({ ts: OLD_SHIP_TS, head: "e".repeat(40), rootRunId: "rv-gone" })
    givenReview("review-nobase", "rv-nobase", { base: null, repoRoot: repo })
    givenReview("review-gone", "rv-gone", { base })
    box.git(repo, "checkout", "-q", "-b", "side", base)
    const sideHead = commitAt(repo, daysAgo(30), "Side work", "side.ts", ["side"])
    givenPass({ ts: OLD_SHIP_TS, head: sideHead, rootRunId: "rv-side" })
    givenReview("review-side", "rv-side", { base, repoRoot: repo })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual(rework.not_computable, {
      "head not on the default branch": 1, "no head": 1, "no local checkout holds the head": 1,
      "no review base": 1, "no root review evidence": 1, "no root run id": 1,
    })
    assert.equal(rework.decided_ships, 0)
  })

  it("rework_withoutAnOriginHead_isNotComputable", () => {
    const { repo, base, head } = shipRepo()
    box.git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
    givenPass({ head, ts: OLD_SHIP_TS })
    givenReview("review-a", "rv-a", { base, repoRoot: repo })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "no origin/HEAD": 1 })
  })

  it("noFiresOrEvidence_countsZero_insteadOfFailing", () => {
    const result = runMetric()
    assert.deepEqual([result.count, result.items, result.status, result.error], [0, [], "GRACE", undefined])
  })
})
