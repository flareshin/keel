import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import fs from "node:fs"
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

  const givenReview = (evidenceId: string, fields: { createdAt?: string; repoRoot?: string } = {}): void => {
    const createdAt = fields.createdAt ?? daysAgo(1, "08:00:00Z")
    box.write(`data/state/keel/evidence/review/${REPO.replace("/", "__")}/${evidenceId}.json`, JSON.stringify({
      evidence_id: evidenceId, run_id: "rv-recent", root_run_id: "rv-recent", repo: REPO, since: null,
      created_at: createdAt, expires_at: addDays(createdAt.slice(0, 10), 14) + createdAt.slice(10), verdict: "PASS",
      review_base: "0".repeat(40), repo_root: fields.repoRoot ?? path.join(box.root, "missing"),
    }))
  }

  const givenApproval = (evidenceId: string, rootRunId: string, createdAt: string, headReview: string, headsRepo: string = REPO): void => {
    box.write(`data/state/keel/evidence/approval/${evidenceId}.json`, JSON.stringify({
      evidence_id: evidenceId, kind: "approval", root_run_id: rootRunId, created_at: createdAt,
      expires_at: addDays(createdAt.slice(0, 10), 14) + createdAt.slice(10), heads: { [headsRepo]: headReview },
    }))
  }

  const gitAt = (repo: string, when: string, ...args: string[]): void => {
    const completed = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...box.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
    assert.equal(completed.status, 0, completed.stderr)
  }

  const commitAt = (repo: string, when: string, message: string, lines: string[], file: string = "app.ts"): string => {
    box.write(path.relative(box.root, path.join(repo, file)), lines.join("\n") + "\n")
    gitAt(repo, when, "add", "-A")
    gitAt(repo, when, "commit", "-q", "--no-verify", "-m", message)
    return box.git(repo, "rev-parse", "HEAD").trim()
  }

  const SHIPPED = ["start", "one", "two", "three", "four"]

  const newRepo = (): { repo: string; start: string } => {
    const repo = path.dirname(box.write("app/.keep", ""))
    box.initRepo(repo)
    gitAt(repo, daysAgo(35), "checkout", "-q", "-b", "main")
    return { repo, start: commitAt(repo, daysAgo(35), "Start", ["start"]) }
  }

  const mergedShip = (repo: string, mergedDaysAgo: number = 30): string => {
    gitAt(repo, daysAgo(31), "checkout", "-q", "-b", "feature")
    const head = commitAt(repo, daysAgo(31), "Add the four lines", SHIPPED)
    gitAt(repo, daysAgo(mergedDaysAgo, "08:00:00Z"), "checkout", "-q", "main")
    gitAt(repo, daysAgo(mergedDaysAgo, "08:00:00Z"), "merge", "-q", "--no-ff", "-m", "Merge the feature", "feature")
    return head
  }

  const laterEdits = (repo: string): void => {
    commitAt(repo, daysAgo(25), "Fix the second line", ["start", "one", "TWO", "three", "four"])
    commitAt(repo, daysAgo(24), "refactor: wrap the third line", ["start", "one", "TWO", "(three)", "four"])
    commitAt(repo, daysAgo(10), "Change the fourth line after the horizon", ["start", "one", "TWO", "(three)", "FOUR"])
  }

  const publish = (repo: string): void => {
    gitAt(repo, daysAgo(5), "commit", "-q", "--no-verify", "--allow-empty", "-m", "Later work")
    track(repo)
  }

  const track = (repo: string): void => {
    box.git(repo, "update-ref", "refs/remotes/origin/main", "main")
    box.git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    givenReview("review-recent", { repoRoot: repo })
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
    givenReview("review-a", { createdAt: daysAgo(3, "08:00:00Z") })
    givenReview("review-b", { createdAt: daysAgo(3, "08:00:00Z") })
    givenApproval("approval-a2", "rv-a", daysAgo(3, "09:00:00Z"), "review-a")
    givenApproval("approval-a1", "rv-a", daysAgo(3, "08:10:00Z"), "review-a")
    givenApproval("approval-b", "rv-b", daysAgo(3, "08:30:00Z"), "review-b")
    const result = runMetric()
    assert.deepEqual(itemFor(result, "light")["review_to_approval"], { approved_ships: 2, no_approval_evidence: 1, median_minutes: 20 })
  })

  it("rework_ofAMergedShip_countsLinesChangedWithinFourteenDays_skippingRefactorOnlyCommitsAndLaterChanges_withItsReviewEvidenceGone", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    laterEdits(repo)
    publish(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"], {
      decided_ships: 1, pending_ships: 0, not_computable: {}, shipped_lines: 4, reworked_lines: 1, rate_percent: 25,
    })
  })

  it("rework_ofAFastForwardedShip_startsAtTheEarlierShipOfTheRepo", () => {
    const { repo, start } = newRepo()
    const head = commitAt(repo, daysAgo(31), "Add the four lines", SHIPPED)
    laterEdits(repo)
    publish(repo)
    givenPass({ head: start, ts: daysAgo(35, "10:00:00Z"), risk: "standard" })
    givenPass({ head, ts: OLD_SHIP_TS })
    const result = runMetric()
    assert.deepEqual([itemFor(result, "light")["rework"]["shipped_lines"], itemFor(result, "light")["rework"]["reworked_lines"]], [4, 1])
    assert.deepEqual(itemFor(result, "standard")["rework"]["not_computable"], { "no earlier ship bounds a fast-forwarded head": 1 })
  })

  it("rework_followsARenameWithinFourteenDays_soMovedLinesAreNotReworked", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    gitAt(repo, daysAgo(25), "mv", "app.ts", "relocated.ts")
    gitAt(repo, daysAgo(25), "commit", "-q", "--no-verify", "-m", "Relocate the app file")
    publish(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.shipped_lines, rework.reworked_lines], [1, 4, 0])
  })

  it("rework_ofAShipMergedAfterItsHorizon_isNotComputable_notFullyReworked", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo, 10)
    publish(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "head reached the default branch after the horizon": 1 })
  })

  it("rework_ofAShipYoungerThanFourteenDays_isPending_notZero", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    publish(repo)
    givenPass({ head, ts: RECENT_SHIP_TS })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.pending_ships, rework.rate_percent], [0, 1, null])
  })

  it("rework_namesWhyEachOldShipCannotBeComputed", () => {
    const { repo, start } = newRepo()
    publish(repo)
    gitAt(repo, daysAgo(31), "checkout", "-q", "-b", "side", start)
    const sideHead = commitAt(repo, daysAgo(31), "Side work", ["side"], "side.ts")
    givenPass({ ts: OLD_SHIP_TS, head: null })
    givenPass({ ts: OLD_SHIP_TS, head: "e".repeat(40) })
    givenPass({ ts: OLD_SHIP_TS, head: sideHead })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], {
      "head not on the default branch": 1, "no head": 1, "no local checkout holds the head": 1,
    })
  })

  it("rework_withoutAnOriginHead_isNotComputable", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    publish(repo)
    box.git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "no origin/HEAD": 1 })
  })

  const cacheFile = () => path.join(box.root, "data", "state", "keel", "metrics", "risk-rework.json")

  it("rework_ofADecidedShip_isKeptAfterItsCheckoutIsGone", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    laterEdits(repo)
    publish(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    runMetric()
    fs.rmSync(repo, { recursive: true, force: true })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.not_computable, rework.shipped_lines, rework.reworked_lines], [1, {}, 4, 1])
  })

  it("rework_ofPendingOrNotComputableShips_isNotCached", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    publish(repo)
    givenPass({ head, ts: RECENT_SHIP_TS })
    givenPass({ ts: OLD_SHIP_TS, head: "e".repeat(40) })
    runMetric()
    assert.equal(fs.existsSync(cacheFile()), false)
  })

  it("rework_withAnUnreadableCache_isComputedAgain", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    laterEdits(repo)
    publish(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    box.write(path.relative(box.root, cacheFile()), "{not json")
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.shipped_lines, rework.reworked_lines], [4, 1])
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(cacheFile(), "utf8"))).length, 1)
  })

  it("reviewToApproval_matchesTheApprovalHeadsRepo_ignoringCase", () => {
    givenPass({ rootRunId: "rv-a" })
    givenReview("review-a", { createdAt: daysAgo(3, "08:00:00Z") })
    givenApproval("approval-a", "rv-a", daysAgo(3, "08:15:00Z"), "review-a", "Example/App")
    assert.deepEqual(itemFor(runMetric(), "light")["review_to_approval"], { approved_ships: 1, no_approval_evidence: 0, median_minutes: 15 })
  })

  it("rework_ofAFastForwardedShip_isBoundedByAnEarlierShipOutsideTheWindow", () => {
    const { repo, start } = newRepo()
    const head = commitAt(repo, daysAgo(31), "Add the four lines", SHIPPED)
    laterEdits(repo)
    publish(repo)
    givenPass({ head: start, ts: daysAgo(65, "10:00:00Z"), risk: "standard" })
    givenPass({ head, ts: OLD_SHIP_TS })
    const result = runMetric()
    assert.deepEqual(result.items.map((item: { class: string }) => item.class), ["light"])
    assert.deepEqual([itemFor(result, "light")["rework"]["shipped_lines"], itemFor(result, "light")["rework"]["reworked_lines"]], [4, 1])
  })

  it("rework_ofAFastForwardedShip_isBoundedOnlyByAnEarlierShipOnItsFirstParentChain", () => {
    const { repo, start } = newRepo()
    gitAt(repo, daysAgo(34), "checkout", "-q", "-b", "side")
    const mergedHead = commitAt(repo, daysAgo(34), "Side work", ["side"], "side.ts")
    gitAt(repo, daysAgo(33), "checkout", "-q", "main")
    const directHead = commitAt(repo, daysAgo(33), "Direct work", ["direct", "work"], "direct.ts")
    gitAt(repo, daysAgo(32), "merge", "-q", "--no-ff", "-m", "Merge the side work", "side")
    const head = commitAt(repo, daysAgo(31), "Add the four lines", ["one", "two", "three", "four"], "four.ts")
    publish(repo)
    givenPass({ head: start, ts: daysAgo(35, "10:00:00Z"), risk: "heavy" })
    givenPass({ head: directHead, ts: daysAgo(33, "10:00:00Z"), risk: "standard" })
    givenPass({ head: mergedHead, ts: daysAgo(32, "10:00:00Z"), risk: "smoke-only" })
    givenPass({ head, ts: OLD_SHIP_TS })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.shipped_lines, rework.reworked_lines], [1, 4, 0])
  })

  it("rework_withADefaultBranchNotFetchedPastTheHorizon_isNotComputable_andIsDecidedAfterTheFetch", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    const mergeCommit = box.git(repo, "rev-parse", "HEAD").trim()
    laterEdits(repo)
    publish(repo)
    box.git(repo, "update-ref", "refs/remotes/origin/main", mergeCommit)
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "default branch not fetched past the horizon": 1 })
    assert.equal(fs.existsSync(cacheFile()), false)
    box.git(repo, "update-ref", "refs/remotes/origin/main", "main")
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.shipped_lines, rework.reworked_lines], [1, 4, 1])
  })

  const ORIGIN_FETCH_URL = "https://example.invalid/example/keel"

  const givenFetchHead = (repo: string, branch: string, fetchedDaysAgo: number, gitDir: string = ".git", url: string = ORIGIN_FETCH_URL): void => {
    const file = path.join(repo, gitDir, "FETCH_HEAD")
    box.write(path.relative(box.root, file), `${"f".repeat(40)}\t\tbranch '${branch}' of ${url}\n`)
    const fetchedAt = new Date(daysAgo(fetchedDaysAgo))
    fs.utimesSync(file, fetchedAt, fetchedAt)
  }

  it("rework_ofAQuietRepo_isDecided_whenTheDefaultBranchWasFetchedAfterTheHorizon", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    givenFetchHead(repo, "main", 1)
    givenPass({ head, ts: OLD_SHIP_TS })
    const rework = itemFor(runMetric(), "light")["rework"]
    assert.deepEqual([rework.decided_ships, rework.shipped_lines, rework.reworked_lines], [1, 4, 0])
  })

  it("rework_ofAQuietRepo_isDecided_whenAnotherWorktreeOfTheRepoFetchedTheDefaultBranch", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    box.git(repo, "worktree", "add", "-q", path.join(path.dirname(repo), "topic"), "-b", "topic")
    givenFetchHead(repo, "main", 1, path.join(".git", "worktrees", "topic"))
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.equal(itemFor(runMetric(), "light")["rework"]["decided_ships"], 1)
  })

  it("rework_ofAQuietRepo_isDecided_whenALocalBranchSharesTheRemoteDefaultBranchName", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    box.git(repo, "branch", "origin/main")
    givenFetchHead(repo, "main", 1)
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.equal(itemFor(runMetric(), "light")["rework"]["decided_ships"], 1)
  })

  it("rework_ofAQuietRepo_isNotFetchedPastTheHorizon_whenOriginHeadIsAPlainRef", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    box.git(repo, "update-ref", "--no-deref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    givenFetchHead(repo, "main", 1)
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "default branch not fetched past the horizon": 1 })
  })

  it("rework_ofAQuietRepo_isNotComputable_whenTheDefaultBranchWasFetchedFromAnotherRemote", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    givenFetchHead(repo, "main", 1, ".git", "https://example.invalid/fork/keel")
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "default branch not fetched past the horizon": 1 })
  })

  it("rework_ofAQuietRepo_isDecided_whenOriginsUrlCarriesAUserThatFetchHeadLeavesOut", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    box.git(repo, "remote", "set-url", "origin", "https://reader@example.invalid/example/keel.git/")
    givenFetchHead(repo, "main", 1)
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.equal(itemFor(runMetric(), "light")["rework"]["decided_ships"], 1)
  })

  it("rework_ofAQuietRepo_isDecided_whenAnScpLikeOriginWasFetched", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    box.git(repo, "remote", "set-url", "origin", "git@example.invalid:example/keel.git")
    givenFetchHead(repo, "main", 1, ".git", "example.invalid:example/keel")
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.equal(itemFor(runMetric(), "light")["rework"]["decided_ships"], 1)
  })

  it("rework_ofAQuietRepo_isNotFetchedPastTheHorizon_whenNoOriginRemoteIsLeft", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    givenFetchHead(repo, "main", 1)
    box.git(repo, "config", "--remove-section", "remote.origin")
    givenPass({ head, ts: OLD_SHIP_TS })
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "default branch not fetched past the horizon": 1 })
  })

  it("rework_ofAQuietRepo_isNotComputable_whenTheLastFetchWasAnotherBranchOrBeforeTheHorizon", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    track(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    givenFetchHead(repo, "feature", 1)
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "default branch not fetched past the horizon": 1 })
    givenFetchHead(repo, "main", 20)
    assert.deepEqual(itemFor(runMetric(), "light")["rework"]["not_computable"], { "default branch not fetched past the horizon": 1 })
  })

  it("rework_withACacheFileItCannotRead_isComputedAgain", () => {
    const { repo } = newRepo()
    const head = mergedShip(repo)
    laterEdits(repo)
    publish(repo)
    givenPass({ head, ts: OLD_SHIP_TS })
    box.write(path.relative(box.root, cacheFile()), "{}")
    fs.chmodSync(cacheFile(), 0o000)
    const result = runMetric()
    assert.equal(result.error, undefined)
    assert.deepEqual([itemFor(result, "light")["rework"]["shipped_lines"], itemFor(result, "light")["rework"]["reworked_lines"]], [4, 1])
  })

  it("noFiresOrEvidence_countsZero_insteadOfFailing", () => {
    const result = runMetric()
    assert.deepEqual([result.count, result.items, result.status, result.error], [0, [], "GRACE", undefined])
  })
})
