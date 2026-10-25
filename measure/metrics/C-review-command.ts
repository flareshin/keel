#!/usr/bin/env node
import { KIND as CODEX_REVIEW_KIND } from "../../lib/evidence/codex_review.ts"
import * as store from "../../lib/evidence/store.ts"
import { dateOption, noPositionals, parseCommandLine, printJson, runMain, stringOption, usageError } from "../lib/measurekit/cli.ts"
import type { CommandSpec } from "../lib/measurekit/cli.ts"
import { isWithinWindow } from "../lib/measurekit/metrics.ts"

const COMMAND: CommandSpec = {
  prog: "measure/metrics/C-review-command",
  usage: "measure/metrics/C-review-command [-h] --since YYYY-MM-DD",
  description: "Count the formal Codex review runs registered as review evidence since a date; each is an occasion for C-review-command.",
  argumentHelp: [["--since YYYY-MM-DD", "window start"]],
  options: { since: { type: "string" } },
}

function main(argv: string[]): number {
  const parsed = parseCommandLine(COMMAND, argv)
  noPositionals(COMMAND, parsed)
  const since = dateOption(COMMAND, "--since", stringOption(parsed, "since"))
  if (since === undefined) usageError(COMMAND, "the argument --since is required")
  const runs = new Map<string, { run_id: string; repo: string; verdict: string; created_at: string }>()
  for (const repoKey of store.repoKeys("review")) {
    for (const file of store.listFiles("review", repoKey)) {
      const review = store.readFile(file) as store.ReviewEvidence
      const registeredInWindow = isWithinWindow({ ts: review.created_at }, since)
      if (review.review_kind === CODEX_REVIEW_KIND && registeredInWindow && !runs.has(review.run_id)) {
        runs.set(review.run_id, { run_id: review.run_id, repo: review.repo, verdict: review.verdict, created_at: review.created_at })
      }
    }
  }
  printJson({ count: runs.size, items: [...runs.values()] })
  return 0
}

runMain(main)
