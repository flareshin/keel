#!/usr/bin/env node
import fs from "node:fs"

import { ArgumentParser } from "./lib/measurekit/argparse.ts"
import { EXIT_OK, printJson, runMain } from "./lib/measurekit/cli.ts"
import { runGit } from "./lib/measurekit/gitutil.ts"
import { collectMetricItems, MetricError } from "./lib/measurekit/metrics.ts"
import { buildExpiryProposals } from "./lib/measurekit/propose.ts"
import { isDir, isFile, pyJoin, pySplitext } from "./lib/measurekit/pypath.ts"
import { countNewlines } from "./lib/measurekit/pyio.ts"
import { sortedByCodePoint } from "./lib/measurekit/pystr.ts"
import type { PyValue } from "./lib/measurekit/pyvalue.ts"
import { SmokeContext } from "./lib/measurekit/smoke_context.ts"

const DEFECT_RUNNER_PREFIX = "defects-"
const TESTS_PREFIX = "tests/"
const EXECUTABLE_MODE = "100755"
const CODE_EXTENSIONS = new Set([".py", ".js", ".mjs", ".sh"])

function main(argv: string[]): number {
  new ArgumentParser({ prog: "measure/weekly", description: "Weekly measurement report.", arguments: [] }).parse(argv)
  printJson(buildWeeklyReport(SmokeContext.fromEnvironment()))
  return EXIT_OK
}

function buildWeeklyReport(ctx: SmokeContext): object {
  const rows = ctx.countedRows
  const repoRows = rows.filter((row) => row.layer === "repo").map((row) => row.id)
  return {
    repo_layer_rules: { count: repoRows.length, ids: repoRows },
    always_loaded: {
      claude_md: fileSize(pyJoin(ctx.dataDir, "CLAUDE.md")),
      memory_indexes: ctx.memoryIndexes().reduce((total, path) => total + fileSize(path), 0),
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
    const path = entry.slice(tab + 1)
    const isCode = meta.split(/\s+/)[0] === EXECUTABLE_MODE || CODE_EXTENSIONS.has(pySplitext(path)[1])
    if (!path.startsWith(TESTS_PREFIX) && isCode) lines += countLines(pyJoin(keelHome, path))
  }
  return { non_test_loc: lines, design_md_bytes: fileSize(pyJoin(keelHome, "docs", "DESIGN.md")) }
}

function countLines(path: string): number {
  return isFile(path) ? countNewlines(fs.readFileSync(path)) : 0
}

function collectDefects(ctx: SmokeContext): Record<string, PyValue> {
  const runnerDir = pyJoin(ctx.overlayDir, "measure", "metrics")
  const names = isDir(runnerDir) ? sortedByCodePoint(fs.readdirSync(runnerDir)) : []
  const defects: Record<string, PyValue> = {}
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

function fileSize(path: string): number {
  return isFile(path) ? fs.statSync(path).size : 0
}

runMain(main)
