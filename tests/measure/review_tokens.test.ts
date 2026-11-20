import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import path from "node:path"

import { FUTURE, PAST, MeasureSandbox, charterRow } from "./helpers.ts"

interface Usage {
  input: number
  cacheCreation: number
  cacheRead: number
  output: number
}

interface Turn {
  id: string
  model: string
  usage: Usage
  advisor?: { model: string; usage: Usage }
}

const OPUS = "claude-opus-5-5"
const SONNET = "claude-sonnet-5-5"
const FABLE = "claude-fable-5-2"

function usageFields(usage: Usage): object {
  return {
    input_tokens: usage.input,
    cache_creation_input_tokens: usage.cacheCreation,
    cache_read_input_tokens: usage.cacheRead,
    output_tokens: usage.output,
  }
}

function tokens(input: number, cacheCreation: number, cacheRead: number, output: number): object {
  return { input_tokens: input, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead, output_tokens: output }
}

describe("weekly review_tokens", () => {
  let box: MeasureSandbox

  beforeEach(() => {
    box = new MeasureSandbox()
    box.initRepo(box.keel)
    box.writeLedger("keel/ledger.tsv", [charterRow("K1")])
  })
  afterEach(() => box.cleanup())

  function givenAgent(run: string, agent: string, turns: Turn[]): string {
    const relative = `projects/p/s/subagents/workflows/${run}/agent-${agent}.jsonl`
    const lines = turns.map((turn) => {
      const usage: Record<string, unknown> = usageFields(turn.usage)
      if (turn.advisor) {
        usage["iterations"] = [
          { type: "message", ...usageFields(turn.usage) },
          { type: "advisor_message", model: turn.advisor.model, ...usageFields(turn.advisor.usage) },
        ]
      }
      return JSON.stringify({ type: "assistant", message: { id: turn.id, model: turn.model, usage } })
    })
    box.write(`data/${relative}`, [JSON.stringify({ type: "user", message: { content: "task" } }), ...lines].join("\n") + "\n")
    return relative
  }

  function givenReview(repo: string, evidenceId: string, fields: { rootRunId: string; since?: string; verdict: string; transcript?: string; expired?: boolean }): void {
    box.write(`data/state/keel/evidence/review/${repo.replace("/", "__")}/${evidenceId}.json`, JSON.stringify({
      schema: 1, kind: "review", evidence_id: evidenceId, run_id: fields.since ? `${fields.rootRunId}-${evidenceId}` : fields.rootRunId,
      root_run_id: fields.rootRunId, since: fields.since ?? null, verdict: fields.verdict, paths: [],
      created_at: `${PAST}T08:00:00Z`, expires_at: `${fields.expired ? PAST : FUTURE}T08:00:00Z`,
      ...(fields.transcript === undefined ? {} : { source: { agent_transcript_path: path.join(box.data, fields.transcript) } }),
    }))
  }

  function weeklyReviewTokens(): any {
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    return report.review_tokens
  }

  it("weekly_reportsNoReviewTokens_whenThereIsNoReviewEvidence", () => {
    assert.deepEqual(weeklyReviewTokens(), { roots: 0, unmeasured: 0, by_model: {}, by_needs_fixes_rounds: {} })
  })

  it("weekly_sumsEveryAgentOfEachReviewRunOfAChain_byModelAndByNeedsFixesRounds", () => {
    const rootReport = givenAgent("wf_root", "report", [{ id: "m1", model: OPUS, usage: { input: 1, cacheCreation: 10, cacheRead: 100, output: 1000 } }])
    givenAgent("wf_root", "audit", [{ id: "m2", model: SONNET, usage: { input: 2, cacheCreation: 20, cacheRead: 200, output: 2000 } }])
    const deltaReport = givenAgent("wf_delta", "report", [{ id: "m3", model: OPUS, usage: { input: 3, cacheCreation: 30, cacheRead: 300, output: 3000 } }])
    const otherReport = givenAgent("wf_other", "report", [{ id: "m4", model: OPUS, usage: { input: 4, cacheCreation: 40, cacheRead: 400, output: 4000 } }])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "NEEDS_FIXES", transcript: rootReport })
    givenReview("acme/app", "a2", { rootRunId: "rv-a", since: "a1", verdict: "PASS", transcript: deltaReport })
    givenReview("acme/lib", "b1", { rootRunId: "rv-b", verdict: "PASS", transcript: otherReport })
    assert.deepEqual(weeklyReviewTokens(), {
      roots: 2,
      unmeasured: 0,
      by_model: { [OPUS]: tokens(8, 80, 800, 8000), [SONNET]: tokens(2, 20, 200, 2000) },
      by_needs_fixes_rounds: {
        "0": { roots: 1, ...tokens(4, 40, 400, 4000) },
        "1": { roots: 1, ...tokens(6, 60, 600, 6000) },
      },
    })
  })

  it("weekly_readsTheLastLineOfAStreamedMessage_countsAnAdvisorIterationUnderItsOwnModel_andListsNoModelThatSpentNoTokens", () => {
    const report = givenAgent("wf_streamed", "report", [
      { id: "m1", model: OPUS, usage: { input: 1, cacheCreation: 10, cacheRead: 100, output: 8 } },
      { id: "m1", model: OPUS, usage: { input: 1, cacheCreation: 10, cacheRead: 100, output: 900 }, advisor: { model: FABLE, usage: { input: 5000, cacheCreation: 0, cacheRead: 0, output: 700 } } },
      { id: "m2", model: "<synthetic>", usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 } },
    ])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "PASS", transcript: report })
    assert.deepEqual(weeklyReviewTokens().by_model, { [OPUS]: tokens(1, 10, 100, 900), [FABLE]: tokens(5000, 0, 0, 700) })
  })

  it("weekly_countsAReviewRunOnce_whenItWroteEvidenceForTwoRepos", () => {
    const report = givenAgent("wf_both", "report", [{ id: "m1", model: OPUS, usage: { input: 1, cacheCreation: 10, cacheRead: 100, output: 1000 } }])
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "PASS", transcript: report })
    givenReview("acme/lib", "b1", { rootRunId: "rv-a", verdict: "PASS", transcript: report })
    assert.deepEqual(weeklyReviewTokens(), {
      roots: 1,
      unmeasured: 0,
      by_model: { [OPUS]: tokens(1, 10, 100, 1000) },
      by_needs_fixes_rounds: { "0": { roots: 1, ...tokens(1, 10, 100, 1000) } },
    })
  })

  it("weekly_countsTheTokensOfASupersededHead_underTheRoundsOfTheNewestChain", () => {
    const first = givenAgent("wf_e1", "report", [{ id: "m1", model: OPUS, usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 100 } }])
    const passed = givenAgent("wf_e2", "report", [{ id: "m2", model: OPUS, usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 200 } }])
    const newest = givenAgent("wf_e3", "report", [{ id: "m3", model: OPUS, usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 400 } }])
    givenReview("acme/svc", "e1", { rootRunId: "rv-e", verdict: "NEEDS_FIXES", transcript: first })
    givenReview("acme/svc", "e2", { rootRunId: "rv-e", since: "e1", verdict: "PASS", transcript: passed })
    givenReview("acme/svc", "e3", { rootRunId: "rv-e", since: "e1", verdict: "NEEDS_FIXES", transcript: newest })
    assert.deepEqual(weeklyReviewTokens().by_needs_fixes_rounds, { "2": { roots: 1, ...tokens(3, 0, 0, 700) } })
  })

  it("weekly_leavesARootUnmeasured_whenAnyOfItsReviewsHasNoWorkflowRunWithUsage", () => {
    const measured = givenAgent("wf_ok", "report", [{ id: "m1", model: OPUS, usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 100 } }])
    const fixed = givenAgent("wf_b1", "report", [{ id: "m5", model: OPUS, usage: { input: 5, cacheCreation: 0, cacheRead: 0, output: 500 } }])
    const silent = "projects/p/s/subagents/workflows/wf_silent/agent-report.jsonl"
    box.write(`data/${silent}`, JSON.stringify({ type: "user", message: { content: "task" } }) + "\n")
    const plainAgent = "projects/p/s/subagents/agent-plain.jsonl"
    box.write(`data/${plainAgent}`, JSON.stringify({ type: "assistant", message: { id: "m9", model: OPUS, usage: usageFields({ input: 9, cacheCreation: 0, cacheRead: 0, output: 9 }) } }) + "\n")
    givenReview("acme/app", "a1", { rootRunId: "rv-a", verdict: "PASS", transcript: measured })
    givenReview("acme/app", "b1", { rootRunId: "rv-b", verdict: "NEEDS_FIXES", transcript: fixed })
    givenReview("acme/app", "b2", { rootRunId: "rv-b", since: "b1", verdict: "PASS", transcript: "projects/p/s/subagents/workflows/wf_gone/agent-report.jsonl" })
    givenReview("acme/app", "c1", { rootRunId: "rv-c", verdict: "PASS", transcript: silent })
    givenReview("acme/app", "d1", { rootRunId: "rv-d", verdict: "PASS", transcript: plainAgent })
    givenReview("acme/app", "f1", { rootRunId: "rv-f", verdict: "PASS" })
    givenReview("acme/app", "g1", { rootRunId: "rv-g", verdict: "PASS", transcript: measured, expired: true })
    assert.deepEqual(weeklyReviewTokens(), {
      roots: 1,
      unmeasured: 4,
      by_model: { [OPUS]: tokens(1, 0, 0, 100) },
      by_needs_fixes_rounds: { "0": { roots: 1, ...tokens(1, 0, 0, 100) } },
    })
  })

  it("weekly_reportsAnUnreadableReviewAsAReviewTokensError", () => {
    box.write("data/state/keel/evidence/review/acme__app/broken.json", "{not json")
    const [completed, report] = box.runJson("weekly")
    assert.equal(completed.status, 0, completed.stderr)
    assert.ok(report.review_tokens.error.startsWith("unreadable evidence "), report.review_tokens.error)
  })
})
