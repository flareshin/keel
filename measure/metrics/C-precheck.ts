import path from "node:path"

import { SCRIPT_FILE } from "../../lib/precheck/consumers.ts"
import { isTestPath } from "../../lib/evidence/risk.ts"
import * as store from "../../lib/evidence/store.ts"
import * as env from "../lib/measurekit/env.ts"
import { dateOption, parseCommandLine, printJson, runMain, stringOption, EXIT_OK } from "../lib/measurekit/cli.ts"
import type { CommandSpec } from "../lib/measurekit/cli.ts"
import { readJsonl } from "../lib/measurekit/datafiles.ts"
import { compareCodePoints, isJsonObject } from "../lib/measurekit/json.ts"
import type { JsonObject } from "../lib/measurekit/json.ts"

const COMMAND: CommandSpec = {
  prog: "measure/metrics/C-precheck",
  usage: "measure/metrics/C-precheck --since YYYY-MM-DD",
  description: "Count first reviews covered by [C-precheck] whose tree had a keel precheck run.",
  argumentHelp: [["--since YYYY-MM-DD", "window start"]],
  options: { since: { type: "string" } },
}
const MIN_SOURCE_FILES = 3
const ISO_DATE_LENGTH = 10
const NEEDS_FIXES = "NEEDS_FIXES"
const TESTS_LENSES = new Set(["tests", "test-adequacy"])
const BLOCKING_HEADING = "Merge-blocking"
const BLOCK_END = /\n(?:Non-blocking|Pre-existing|Optional|Adjusted|Refuted|KEEL-EVIDENCE)/
const BLOCKING_FINDING = /^- \[(high|medium)\] ([a-z-]+)\/\S+?: (.*?)(?=^- \[|$(?![\s\S]))/gms
const MUTATION_SHAPED = /revert|remov|delet|drop|replac|swap|invert|flip|weaken|still pass|stays? green|keeps? (?:the suite )?green|would pass|without (?:any )?test fail|no test (?:fails|would fail)|unpinned|not pinned/i

interface FirstReview {
  runId: string
  createdAt: string
  repo: string
  verdict: string
  tree: string
  transcript: string | null
}

function main(argv: string[]): number {
  const since = dateOption(COMMAND, "--since", stringOption(parseCommandLine(COMMAND, argv), "since")) ?? "0000-00-00"
  const prechecked = precheckedTrees()
  const items = [...coveredFirstReviewsByRun(since)]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([runId, repos]) => summarize(runId, repos, prechecked))
  printJson({ count: items.filter((item) => item.prechecked).length, items })
  return EXIT_OK
}

function precheckedTrees(): Set<string> {
  const { records } = readJsonl(path.join(env.logsDir(), "keel-precheck.jsonl"))
  return new Set(records.map((record) => record["tree"]).filter((tree): tree is string => typeof tree === "string"))
}

function coveredFirstReviewsByRun(since: string): Map<string, FirstReview[]> {
  const runs = new Map<string, FirstReview[]>()
  for (const review of reviewEvidence()) {
    if (!isCoveredFirstReview(review, since)) continue
    const runId = review["run_id"] as string
    runs.set(runId, [...(runs.get(runId) ?? []), {
      runId,
      createdAt: review["created_at"] as string,
      repo: review["repo"] as string,
      verdict: review["verdict"] as string,
      tree: review["reviewed_tree"] as string,
      transcript: transcriptPath(review),
    }])
  }
  return runs
}

function reviewEvidence(): JsonObject[] {
  return store.repoKeys("review").flatMap((repoKey) => store.listFiles("review", repoKey).map((file) => store.readFile(file) as JsonObject))
}

function isCoveredFirstReview(review: JsonObject, since: string): boolean {
  const createdAt = review["created_at"]
  if (typeof createdAt !== "string" || createdAt.slice(0, ISO_DATE_LENGTH) < since) return false
  if (review["since"] != null || review["run_id"] !== review["root_run_id"]) return false
  return sourceFileCount(review) >= MIN_SOURCE_FILES
}

function sourceFileCount(review: JsonObject): number {
  const paths = Array.isArray(review["paths"]) ? review["paths"] : []
  return paths
    .map((entry) => (isJsonObject(entry) ? entry["path"] : undefined))
    .filter((changed): changed is string => typeof changed === "string" && SCRIPT_FILE.test(changed) && !isTestPath(changed))
    .length
}

function transcriptPath(review: JsonObject): string | null {
  const source = review["source"]
  const transcript = isJsonObject(source) ? source["agent_transcript_path"] : undefined
  return typeof transcript === "string" ? transcript : null
}

function summarize(runId: string, repos: FirstReview[], prechecked: Set<string>) {
  const first = repos[0] as FirstReview
  return {
    run_id: runId,
    created_at: first.createdAt,
    repos: repos.map((review) => review.repo),
    verdict: first.verdict,
    prechecked: repos.every((review) => prechecked.has(review.tree)),
    mutation_tests_findings: first.verdict === NEEDS_FIXES ? mutationShapedTestsFindings(first.transcript) : 0,
  }
}

function mutationShapedTestsFindings(transcript: string | null): number | null {
  const report = transcript === null ? null : lastAssistantText(transcript)
  if (report === null || !report.includes(BLOCKING_HEADING)) return null
  const block = report.slice(report.indexOf(BLOCKING_HEADING) + BLOCKING_HEADING.length).split(BLOCK_END)[0] as string
  return [...block.matchAll(BLOCKING_FINDING)]
    .filter(([, , lens, text]) => TESTS_LENSES.has(lens as string) && MUTATION_SHAPED.test(text as string))
    .length
}

function lastAssistantText(transcript: string): string | null {
  let last: string | null = null
  for (const record of readJsonl(transcript).records) {
    const message = record["message"]
    if (!isJsonObject(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) continue
    for (const part of message["content"]) {
      if (isJsonObject(part) && part["type"] === "text" && typeof part["text"] === "string") last = part["text"]
    }
  }
  return last
}

runMain(main)
