#!/usr/bin/env node
import { EXIT_OK, noPositionals, parseCommandLine, printJson, runMain, stringOption } from "./lib/measurekit/cli.ts"
import type { CommandSpec } from "./lib/measurekit/cli.ts"
import { buildExpiryProposals, buildRereviewProposals } from "./lib/measurekit/propose.ts"
import { SmokeContext } from "./lib/measurekit/smoke_context.ts"

const COMMAND: CommandSpec = {
  prog: "measure/propose",
  usage: "measure/propose [-h] [--model-upgrade MODEL]",
  description: "Propose demotions for expired ledger rows.",
  argumentHelp: [["--model-upgrade MODEL", "emit one re-review proposal per active row instead"]],
  options: { "model-upgrade": { type: "string" } },
}

function main(argv: string[]): number {
  const parsed = parseCommandLine(COMMAND, argv)
  noPositionals(COMMAND, parsed)
  const ctx = SmokeContext.fromEnvironment()
  const modelUpgrade = stringOption(parsed, "model-upgrade")
  const proposals = modelUpgrade
    ? buildRereviewProposals(ctx.countedRows, modelUpgrade)
    : buildExpiryProposals(ctx.countedRows, ctx.metricWindowStart, ctx.today)
  printJson({ proposals })
  return EXIT_OK
}

runMain(main)
