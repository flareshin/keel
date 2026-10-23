#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import path from "node:path"

import { EXIT_NEGATIVE, EXIT_OK, flagOption, noPositionals, parseCommandLine, printJson, runMain } from "./lib/measurekit/cli.ts"
import type { CommandSpec } from "./lib/measurekit/cli.ts"
import { appendJsonl } from "./lib/measurekit/datafiles.ts"
import { compactUtcSeconds, utcSeconds } from "./lib/measurekit/dates.ts"
import { GitError, isGitRepo, repoKey, snapshotTree } from "./lib/measurekit/gitutil.ts"
import { FAIL, PASS } from "./lib/measurekit/metrics.ts"
import { assertion, SmokeContext } from "./lib/measurekit/smoke_context.ts"
import type { Assertion } from "./lib/measurekit/smoke_context.ts"
import { checkBoundary, checkDangling, checkFileCaps, checkFiresRuleIds, checkIdTagging, checkLinkIntegrity } from "./lib/measurekit/smoke_files.ts"
import { checkExpiry, checkIdUnique, checkLedgerFormat, checkMetrics, checkRowCaps, checkRuleOfTwo } from "./lib/measurekit/smoke_ledger.ts"
import { checkModTrust } from "./lib/measurekit/smoke_mods.ts"
import { checkWiredFires } from "./lib/measurekit/smoke_wired.ts"

const COMMAND: CommandSpec = {
  prog: "measure/smoke",
  usage: "measure/smoke [-h] [--json-only] [--candidate]",
  description: "Run every ledger check.",
  argumentHelp: [
    ["--json-only", "print only the JSON result"],
    ["--candidate", "check the link plan of KEEL_HOME and KEEL_OVERLAY_DIR against an empty data dir instead of the live one"],
  ],
  options: { "json-only": { type: "boolean" }, candidate: { type: "boolean" } },
}
const CHECKS: ((ctx: SmokeContext) => Assertion[])[] = [
  checkLedgerFormat, checkIdUnique, checkRowCaps, checkFileCaps, checkIdTagging,
  checkFiresRuleIds, checkRuleOfTwo, checkMetrics, checkExpiry, checkBoundary,
  checkLinkIntegrity, checkDangling, checkWiredFires, checkModTrust,
]
const ASSERTIONS_PER_ROW = 2
const ASSERTION_ALLOWANCE = 40

interface SmokeResult {
  run_id: string
  ok: boolean
  count: number
  cap: number
  assertions: Assertion[]
}

function main(argv: string[]): number {
  const parsed = parseCommandLine(COMMAND, argv)
  noPositionals(COMMAND, parsed)
  const ctx = SmokeContext.fromEnvironment(flagOption(parsed, "candidate"))
  const result = runSmoke(ctx)
  recordSmokeRun(result, ctx)
  printJson(result)
  if (!flagOption(parsed, "json-only")) printSummary(result)
  return result.ok ? EXIT_OK : EXIT_NEGATIVE
}

function runSmoke(ctx: SmokeContext): SmokeResult {
  const assertions = CHECKS.flatMap((check) => check(ctx))
  const cap = ASSERTIONS_PER_ROW * ctx.countedRows.length + ASSERTION_ALLOWANCE
  const count = assertions.length + 1
  assertions.push(assertion("assertion-cap", "all", count <= cap ? PASS : FAIL, `${count}/${cap}`))
  const ok = assertions.every((item) => item.status !== FAIL)
  const runId = `smoke-${compactUtcSeconds(new Date())}-${randomBytes(3).toString("hex")}`
  return { run_id: runId, ok, count, cap, assertions }
}

function recordSmokeRun(result: SmokeResult, ctx: SmokeContext): void {
  const failed = result.assertions.filter((item) => item.status === FAIL).map(({ check, scope, detail }) => ({ check, scope, detail }))
  const line: Record<string, unknown> = {
    ts: utcSeconds(new Date()),
    run_id: result.run_id,
    ok: result.ok,
    count: result.count,
    failed,
    trees: snapshotCheckouts([ctx.keelHome, ctx.overlayDir]),
  }
  if (ctx.candidate) line["candidate"] = true
  appendJsonl(path.join(ctx.dataDir, "logs", "keel-smoke.jsonl"), line)
}

function snapshotCheckouts(checkouts: string[]): Record<string, string> {
  const trees: Record<string, string> = {}
  for (const checkout of checkouts.filter(isGitRepo)) {
    const key = repoKey(checkout)
    if (key === null) {
      process.stderr.write(`smoke: ${checkout} has no owner/repo origin; its tree is not recorded\n`)
      continue
    }
    try {
      trees[key] = snapshotTree(checkout)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      process.stderr.write(`smoke: tree snapshot failed for ${checkout}: ${error.message}\n`)
    }
  }
  return trees
}

function printSummary(result: SmokeResult): void {
  for (const item of result.assertions) {
    if (item.status !== PASS) process.stderr.write(`${item.status.padEnd(5)} ${item.check}/${item.scope}: ${item.detail}\n`)
  }
  const verdict = result.ok ? "ok" : "FAILED"
  process.stderr.write(`smoke ${verdict}: ${result.count} assertions (cap ${result.cap}), run ${result.run_id}\n`)
}

runMain(main)
