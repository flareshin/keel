#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

import { isTestPath } from "../lib/evidence/risk.ts"
import { EXIT_OK, noPositionals, parseCommandLine, printJson, runMain } from "./lib/measurekit/cli.ts"
import type { CommandSpec } from "./lib/measurekit/cli.ts"
import { isFile } from "./lib/measurekit/files.ts"
import { runGitOrThrow } from "./lib/measurekit/gitutil.ts"
import type { JsonValue } from "./lib/measurekit/json.ts"
import { summarizeHarnessVersions } from "./lib/measurekit/harness_versions.ts"
import { collectMetricItems, defectRunnerNames, MetricError } from "./lib/measurekit/metrics.ts"
import { buildExpiryProposals } from "./lib/measurekit/propose.ts"
import { summarizeRecurringFindings } from "./lib/measurekit/recurring_findings.ts"
import { summarizeReviewRounds } from "./lib/measurekit/review_rounds.ts"
import { summarizeReviewTokens } from "./lib/measurekit/review_tokens.ts"
import { SmokeContext } from "./lib/measurekit/smoke_context.ts"

const COMMAND: CommandSpec = {
  prog: "measure/weekly",
  usage: "measure/weekly [-h]",
  description: "Weekly measurement report.",
  argumentHelp: [],
  options: {},
}
const EXECUTABLE_MODE = "100755"
const CODE_EXTENSIONS = new Set([".py", ".js", ".mjs", ".sh", ".ts"])
const NEWLINE_BYTE = 0x0a

function main(argv: string[]): number {
  noPositionals(COMMAND, parseCommandLine(COMMAND, argv))
  printJson(buildWeeklyReport(SmokeContext.fromEnvironment()))
  return EXIT_OK
}

function buildWeeklyReport(ctx: SmokeContext): object {
  const rows = ctx.countedRows
  const repoRows = rows.filter((row) => row.layer === "repo").map((row) => row.id)
  return {
    repo_layer_rules: { count: repoRows.length, ids: repoRows },
    always_loaded: {
      claude_md: fileSize(path.join(ctx.dataDir, "CLAUDE.md")),
      memory_indexes: ctx.memoryIndexes().reduce((total, index) => total + fileSize(index), 0),
    },
    core_size: measureCoreSize(ctx.keelHome),
    defects: collectDefects(ctx),
    proposals: buildExpiryProposals(rows, ctx.metricWindowStart, ctx.today),
    review_rounds: summarizeReviewRounds(),
    review_tokens: summarizeReviewTokens(),
    harness_versions: summarizeHarnessVersions(ctx.keelHome),
    recurring_findings: summarizeRecurringFindings(),
  }
}

function measureCoreSize(keelHome: string): object {
  const index = runGitOrThrow(keelHome, ["ls-files", "-s", "-z"])
  let lines = 0
  for (const entry of index.split("\0").filter((candidate) => candidate !== "")) {
    const tab = entry.indexOf("\t")
    const meta = entry.slice(0, tab)
    const trackedPath = entry.slice(tab + 1)
    const isCode = meta.split(/\s+/)[0] === EXECUTABLE_MODE || CODE_EXTENSIONS.has(path.extname(trackedPath))
    if (!isTestPath(trackedPath) && isCode) lines += countLines(path.join(keelHome, trackedPath))
  }
  return { non_test_loc: lines, design_md_bytes: fileSize(path.join(keelHome, "docs", "DESIGN.md")) }
}

function countLines(file: string): number {
  if (!isFile(file)) return 0
  return fs.readFileSync(file).reduce((count, byte) => (byte === NEWLINE_BYTE ? count + 1 : count), 0)
}

function collectDefects(ctx: SmokeContext): Record<string, JsonValue> {
  const defects: Record<string, JsonValue> = {}
  for (const name of defectRunnerNames(ctx.overlayDir)) {
    try {
      const [count, items] = collectMetricItems("run:" + name, ctx.metricWindowStart)
      defects[name] = { count, items }
    } catch (error) {
      if (!(error instanceof MetricError)) throw error
      defects[name] = { error: error.message }
    }
  }
  return defects
}

function fileSize(file: string): number {
  return isFile(file) ? fs.statSync(file).size : 0
}

runMain(main)
