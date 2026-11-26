import path from "node:path"

import * as registry from "../../../lib/evidence/registry.ts"
import { readJsonl } from "./datafiles.ts"
import * as env from "./env.ts"
import { InvalidUtf8Error, isSystemError } from "./files.ts"
import { FIRES_LOG, isSyntheticSession } from "./fireslog.ts"
import { GitError, repoKey, runGitOrThrow } from "./gitutil.ts"
import type { JsonObject } from "./json.ts"

const SHIP_GATE = "ship-gate"
const PASS = "pass"
const DENY = "deny"
const WARN = "warn"
const EXAMPLES = 5
const SHORT_SHA = 12
const REFLOG_TIME = /@\{(\d+)\}$/

type Bucket = "covered" | "after_pass" | "denied_only" | "warned_only" | "no_fire"
const REPORTED_EXAMPLES: Bucket[] = ["after_pass", "denied_only", "warned_only", "no_fire"]

export interface RepoLandings {
  updates: number
  commits: number
  covered: number
  after_pass: number
  denied_only: number
  warned_only: number
  no_fire: number
  examples: Partial<Record<Bucket, string[]>>
}

interface OriginUpdate {
  previous: string
  tip: string
}

export function summarizeUngatedLandings(checkouts: string[], since: string): Record<string, RepoLandings | { error: string }> | { error: string } {
  let fires: JsonObject[]
  try {
    fires = readJsonl(path.join(env.logsDir(), FIRES_LOG)).records
  } catch (error) {
    if (!(error instanceof InvalidUtf8Error || isSystemError(error))) throw error
    return { error: `unreadable ${FIRES_LOG}: ${error.message}` }
  }
  const report: Record<string, RepoLandings | { error: string }> = {}
  for (const checkout of checkouts) {
    const key = repoKey(checkout)
    if (key === null || key in report) continue
    let row: registry.GatedRepo | null
    try {
      row = registry.lookup(key)
    } catch (error) {
      if (!(error instanceof registry.RegistryError || error instanceof InvalidUtf8Error || isSystemError(error))) throw error
      return { error: error.message }
    }
    if (!registry.isGated(row)) {
      report[key] = { error: `${key} is not a gated repo in gated-repos.tsv` }
      continue
    }
    try {
      report[key] = classifyLandings(checkout, row!.integrationBase, key, fires, since)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      report[key] = { error: error.message }
    }
  }
  return report
}

export function classifyLandings(checkout: string, integrationBase: string, key: string, fires: JsonObject[], since: string): RepoLandings {
  const outcomesByHead = shipGateOutcomes(fires, key)
  const result: RepoLandings = { updates: 0, commits: 0, covered: 0, after_pass: 0, denied_only: 0, warned_only: 0, no_fire: 0, examples: {} }
  const seen = new Set<string>()
  for (const update of originUpdates(checkout, "refs/remotes/origin/" + integrationBase, since)) {
    result.updates++
    const headsHere = revList(checkout, [update.tip, "--not", update.previous]).filter((sha) => outcomesByHead.has(sha))
    const headsWith = (outcome: string) => headsHere.filter((sha) => outcomesByHead.get(sha)!.has(outcome))
    const reached = (heads: string[]) => new Set(heads.flatMap((head) => revList(checkout, ["--no-merges", head, "--not", update.previous])))
    const passHeads = headsWith(PASS)
    const ranges: [Bucket, Set<string>][] = [
      ["covered", reached(passHeads)],
      ["denied_only", reached(headsWith(DENY))],
      ["warned_only", reached(headsWith(WARN))],
      ["after_pass", new Set(passHeads.flatMap((head) => revList(checkout, ["--no-merges", "--ancestry-path", `${head}..${update.tip}`])))],
    ]
    for (const sha of revList(checkout, ["--no-merges", update.tip, "--not", update.previous])) {
      if (seen.has(sha)) continue
      seen.add(sha)
      const bucket: Bucket = ranges.find(([, commits]) => commits.has(sha))?.[0] ?? "no_fire"
      result.commits++
      result[bucket]++
      if (REPORTED_EXAMPLES.includes(bucket)) {
        const examples = (result.examples[bucket] ??= [])
        if (examples.length < EXAMPLES) examples.push(sha.slice(0, SHORT_SHA))
      }
    }
  }
  return result
}

function shipGateOutcomes(fires: JsonObject[], key: string): Map<string, Set<string>> {
  const outcomesByHead = new Map<string, Set<string>>()
  for (const fire of fires) {
    if (fire["hook"] !== SHIP_GATE || isSyntheticSession(fire["session"])) continue
    if (typeof fire["repo"] !== "string" || fire["repo"].toLowerCase() !== key) continue
    if (typeof fire["head"] !== "string" || typeof fire["outcome"] !== "string") continue
    let outcomes = outcomesByHead.get(fire["head"])
    if (!outcomes) outcomesByHead.set(fire["head"], (outcomes = new Set()))
    outcomes.add(fire["outcome"])
  }
  return outcomesByHead
}

function originUpdates(checkout: string, ref: string, since: string): OriginUpdate[] {
  let log: string
  try {
    log = runGitOrThrow(checkout, ["log", "-g", "--date=unix", "--format=%H %gd", ref])
  } catch (error) {
    if (error instanceof GitError) throw new GitError(`no reflog for ${ref}`)
    throw error
  }
  const sinceSeconds = Date.parse(since + "T00:00:00") / 1000
  const tips = log.split("\n").filter((line) => line !== "").map((line) => {
    const [sha, selector] = line.split(" ") as [string, string]
    return { sha, time: Number(REFLOG_TIME.exec(selector)?.[1] ?? 0) }
  }).reverse()
  const updates: OriginUpdate[] = []
  for (let index = 1; index < tips.length; index++) {
    if (tips[index]!.time >= sinceSeconds) updates.push({ previous: tips[index - 1]!.sha, tip: tips[index]!.sha })
  }
  return updates
}

function revList(checkout: string, args: string[]): string[] {
  return runGitOrThrow(checkout, ["rev-list", ...args]).split("\n").filter((line) => line !== "")
}
