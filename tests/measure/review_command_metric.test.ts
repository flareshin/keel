import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import path from "node:path"

import { CHECKOUT, MeasureSandbox, TODAY } from "./helpers.ts"

const RUNNER = path.join(CHECKOUT, "measure", "metrics", "C-review-command")
const SINCE = "2026-09-01"
const BEFORE_SINCE = "2026-08-31T23:59:59Z"
const IN_WINDOW = "2026-09-01T00:00:00Z"

describe("C-review-command runner", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
  })
  afterEach(() => box.cleanup())

  function writeReview(repoDir: string, name: string, fields: Record<string, string>): void {
    const evidence = { schema: 1, kind: "review", evidence_id: name, expires_at: "2099-01-01T00:00:00Z", repo: repoDir, verdict: "PASS", ...fields }
    box.write(`data/state/keel/evidence/review/${repoDir}/${name}.json`, JSON.stringify(evidence))
  }

  function codexReview(runId: string, createdAt: string, repoDir = "acme__app", verdict = "PASS"): void {
    writeReview(repoDir, `review-${runId}-${repoDir}`, { run_id: runId, created_at: createdAt, review_kind: "codex-lens-review", verdict })
  }

  function runRunner(args: string[] = ["--since", SINCE]): { status: number | null; payload: { count: number; items: any[] } | null; stderr: string } {
    const completed = spawnSync(RUNNER, args, { encoding: "utf8", env: box.env, cwd: box.root })
    return { status: completed.status, payload: completed.stdout.trim() ? JSON.parse(completed.stdout) : null, stderr: completed.stderr }
  }

  it("runner_countsEachCodexReviewRunOnce_acrossRepos", () => {
    codexReview("run-one", IN_WINDOW)
    codexReview("run-one", IN_WINDOW, "acme__lib")
    codexReview("run-two", "2026-09-15T12:00:00Z", "acme__lib", "NEEDS_FIXES")
    const { status, payload } = runRunner()
    assert.equal(status, 0)
    assert.equal(payload?.count, 2)
    assert.deepEqual(payload?.items.map((item) => item.run_id).sort(), ["run-one", "run-two"])
  })

  it("runner_ignoresReviewsBeforeTheWindow_andReviewsOfOtherKinds", () => {
    codexReview("run-old", BEFORE_SINCE)
    writeReview("acme__app", "claude-review", { run_id: "run-claude", created_at: IN_WINDOW, review_kind: "lens-review" })
    assert.deepEqual(runRunner().payload, { count: 0, items: [] })
  })

  it("runner_countsAReviewWhoseEvidenceHasExpiredButNotBeenCollected", () => {
    writeReview("acme__app", "expired", { run_id: "run-expired", created_at: IN_WINDOW, review_kind: "codex-lens-review", expires_at: "2026-09-15T00:00:00Z" })
    assert.equal(runRunner().payload?.count, 1)
  })

  it("runner_countsZero_whenNoEvidenceWasEverWritten", () => {
    const { status, payload } = runRunner()
    assert.deepEqual([status, payload], [0, { count: 0, items: [] }])
  })

  it("runner_failsNamingTheFile_whenAnEvidenceFileIsUnreadable", () => {
    box.write("data/state/keel/evidence/review/acme__app/broken.json", "{not json")
    const { status, stderr } = runRunner()
    assert.notEqual(status, 0)
    assert.ok(stderr.includes("broken.json"), stderr)
  })

  it("runner_exitsTwoWithoutADateSinceFlag", () => {
    assert.equal(runRunner([]).status, 2)
  })

  it("seedRow_isPassingOnceACodexReviewIsRegisteredInTheWindow", () => {
    codexReview("run-today", `${TODAY}T08:00:00Z`)
    const completed = spawnSync(process.execPath, [path.join(CHECKOUT, "measure", "run.ts"), "C-review-command"], {
      encoding: "utf8", env: { ...box.env, KEEL_HOME: CHECKOUT }, cwd: box.root,
    })
    const result = JSON.parse(completed.stdout)
    assert.deepEqual([completed.status, result.metric, result.status, result.count], [0, "run:C-review-command", "PASS", 1])
  })
})
