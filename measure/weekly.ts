#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

import { EXIT_OK, noPositionals, parseCommandLine, printJson, runMain } from "./lib/measurekit/cli.ts"
import type { CommandSpec } from "./lib/measurekit/cli.ts"
import { isDir, isFile } from "./lib/measurekit/files.ts"
import { runGit } from "./lib/measurekit/gitutil.ts"
import type { JsonValue } from "./lib/measurekit/json.ts"
import { collectMetricItems, MetricError } from "./lib/measurekit/metrics.ts"
import { buildExpiryProposals } from "./lib/measurekit/propose.ts"
import { SmokeContext } from "./lib/measurekit/smoke_context.ts"

const COMMAND: CommandSpec = {
  prog: "measure/weekly",
  usage: "measure/weekly [-h]",
  description: "Weekly measurement report.",
  argumentHelp: [],
  options: {},
}
const DEFECT_RUNNER_PREFIX = "defects-"
const TESTS_PREFIX = "tests/"
const EXECUTABLE_MODE = "100755"
const CODE_EXTENSIONS = new Set([".py", ".js", ".mjs", ".sh"])
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
  }
}

function measureCoreSize(keelHome: string): object {
  const index = runGit(keelHome, ["ls-files", "-s", "-z"])
  let lines = 0
  for (const entry of index.split("\0").filter((candidate) => candidate !== "")) {
    const tab = entry.indexOf("\t")
    const meta = entry.slice(0, tab)
    const trackedPath = entry.slice(tab + 1)
    const isCode = meta.split(/\s+/)[0] === EXECUTABLE_MODE || CODE_EXTENSIONS.has(path.extname(trackedPath))
    if (!trackedPath.startsWith(TESTS_PREFIX) && isCode) lines += countLines(path.join(keelHome, trackedPath))
  }
  return { non_test_loc: lines, design_md_bytes: fileSize(path.join(keelHome, "docs", "DESIGN.md")) }
}

function countLines(file: string): number {
  if (!isFile(file)) return 0
  return fs.readFileSync(file).reduce((count, byte) => (byte === NEWLINE_BYTE ? count + 1 : count), 0)
}

function collectDefects(ctx: SmokeContext): Record<string, JsonValue> {
  const runnerDir = path.join(ctx.overlayDir, "measure", "metrics")
  const names = isDir(runnerDir) ? fs.readdirSync(runnerDir).sort() : []
  const defects: Record<string, JsonValue> = {}
  for (const name of names.filter((candidate) => candidate.startsWith(DEFECT_RUNNER_PREFIX))) {
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
