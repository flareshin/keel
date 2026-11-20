import fs from "node:fs"
import path from "node:path"

import { buildChains, countNeedsFixesLinks } from "../../../lib/evidence/chain.ts"
import * as store from "../../../lib/evidence/store.ts"
import type { ReviewEvidence } from "../../../lib/evidence/store.ts"
import { readJsonl } from "./datafiles.ts"
import { InvalidUtf8Error, isSystemError } from "./files.ts"
import { compareCodePoints, isJsonObject } from "./json.ts"
import type { JsonObject, JsonValue } from "./json.ts"

const WORKFLOWS_DIRECTORY = "workflows"
const WORKFLOW_RUN_PREFIX = "wf_"
const AGENT_TRANSCRIPT = /^agent-.*\.jsonl$/u
const TOKEN_CLASSES = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const

type TokenClass = (typeof TOKEN_CLASSES)[number]
type Tokens = Record<TokenClass, number>
type TokensByModel = Map<string, Tokens>

export interface ReviewTokens {
  roots: number
  unmeasured: number
  by_model: Record<string, Tokens>
  by_needs_fixes_rounds: Record<string, { roots: number } & Tokens>
}

interface Root {
  reviews: ReviewEvidence[]
  needsFixesRounds: number
}

export function summarizeReviewTokens(): ReviewTokens | { error: string } {
  let roots: Root[]
  try {
    roots = liveRoots()
  } catch (error) {
    if (!(error instanceof store.EvidenceError || error instanceof store.EvidenceTooDeepError)) throw error
    return { error: error.message }
  }
  const counted = new Set<string>()
  const byModel: TokensByModel = new Map()
  const byRounds = new Map<number, { roots: number; tokens: Tokens }>()
  let unmeasured = 0
  for (const root of roots) {
    const runs = root.reviews.map(workflowRunDirectory)
    const usage = runs.every((run) => run !== null) ? measureRuns([...new Set(runs)].filter((run) => !counted.has(run))) : null
    if (usage === null) {
      unmeasured++
      continue
    }
    for (const run of runs) counted.add(run!)
    addByModel(byModel, usage)
    const bucket = byRounds.get(root.needsFixesRounds) ?? { roots: 0, tokens: zeroTokens() }
    bucket.roots++
    for (const tokens of usage.values()) addTokens(bucket.tokens, tokens)
    byRounds.set(root.needsFixesRounds, bucket)
  }
  return {
    roots: roots.length - unmeasured,
    unmeasured,
    by_model: Object.fromEntries([...byModel].sort(([left], [right]) => compareCodePoints(left, right))),
    by_needs_fixes_rounds: Object.fromEntries([...byRounds].sort(([left], [right]) => left - right)
      .map(([rounds, bucket]) => [String(rounds), { roots: bucket.roots, ...bucket.tokens }])),
  }
}

function liveRoots(): Root[] {
  const byRoot = new Map<string, Root>()
  for (const repoKey of store.repoKeys("review")) {
    const reviews = store.loadReviews(repoKey)
    const newestChainSeen = new Set<string>()
    for (const chain of buildChains(reviews)) {
      if (newestChainSeen.has(chain.rootRunId)) continue
      newestChainSeen.add(chain.rootRunId)
      const root = byRoot.get(chain.rootRunId) ?? { reviews: [], needsFixesRounds: 0 }
      root.needsFixesRounds = Math.max(root.needsFixesRounds, countNeedsFixesLinks(chain))
      byRoot.set(chain.rootRunId, root)
    }
    for (const review of reviews) byRoot.get(review.root_run_id)?.reviews.push(review)
  }
  return [...byRoot.values()]
}

function workflowRunDirectory(review: ReviewEvidence): string | null {
  const transcript = isJsonObject(review.source) ? review.source["agent_transcript_path"] : undefined
  if (typeof transcript !== "string") return null
  const run = path.dirname(transcript)
  const isWorkflowRun = path.basename(run).startsWith(WORKFLOW_RUN_PREFIX) && path.basename(path.dirname(run)) === WORKFLOWS_DIRECTORY
  return isWorkflowRun ? run : null
}

function measureRuns(runs: string[]): TokensByModel | null {
  const total: TokensByModel = new Map()
  for (const run of runs) {
    const usage = measureRun(run)
    if (usage === null) return null
    addByModel(total, usage)
  }
  return total
}

function measureRun(run: string): TokensByModel | null {
  let agents: string[]
  try {
    agents = fs.readdirSync(run).filter((name) => AGENT_TRANSCRIPT.test(name)).map((name) => path.join(run, name))
  } catch (error) {
    if (isSystemError(error)) return null
    throw error
  }
  const lastUsageByMessage = new Map<string, { model: string; usage: JsonObject }>()
  for (const agent of agents) {
    let records: JsonObject[]
    try {
      records = readJsonl(agent).records
    } catch (error) {
      if (error instanceof InvalidUtf8Error || isSystemError(error)) return null
      throw error
    }
    for (const record of records) {
      const message = record["message"]
      if (record["type"] !== "assistant" || !isJsonObject(message) || !isJsonObject(message["usage"])) continue
      if (typeof message["id"] !== "string" || typeof message["model"] !== "string") continue
      lastUsageByMessage.set(message["id"], { model: message["model"], usage: message["usage"] })
    }
  }
  if (lastUsageByMessage.size === 0) return null
  const byModel: TokensByModel = new Map()
  for (const { model, usage } of lastUsageByMessage.values()) {
    for (const [iterationModel, tokens] of usageByModel(model, usage)) addTokens(tokensFor(byModel, iterationModel), tokens)
  }
  return byModel
}

function usageByModel(model: string, usage: JsonObject): [string, Tokens][] {
  const iterations = usage["iterations"]
  if (!Array.isArray(iterations) || iterations.length === 0) return [[model, readTokens(usage)]]
  return iterations.filter(isJsonObject).map((iteration): [string, Tokens] => {
    const iterationModel = iteration["model"]
    return [typeof iterationModel === "string" ? iterationModel : model, readTokens(iteration)]
  })
}

function readTokens(usage: JsonObject): Tokens {
  const tokens = zeroTokens()
  for (const tokenClass of TOKEN_CLASSES) tokens[tokenClass] = countOf(usage[tokenClass])
  return tokens
}

function countOf(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function addByModel(total: TokensByModel, usage: TokensByModel): void {
  for (const [model, tokens] of usage) {
    if (TOKEN_CLASSES.some((tokenClass) => tokens[tokenClass] > 0)) addTokens(tokensFor(total, model), tokens)
  }
}

function tokensFor(byModel: TokensByModel, model: string): Tokens {
  const tokens = byModel.get(model) ?? zeroTokens()
  byModel.set(model, tokens)
  return tokens
}

function addTokens(total: Tokens, tokens: Tokens): void {
  for (const tokenClass of TOKEN_CLASSES) total[tokenClass] += tokens[tokenClass]
}

function zeroTokens(): Tokens {
  return { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
}
