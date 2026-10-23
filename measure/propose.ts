#!/usr/bin/env node
import { ArgumentParser } from "./lib/measurekit/argparse.ts"
import { EXIT_OK, printJson, runMain } from "./lib/measurekit/cli.ts"
import { buildExpiryProposals, buildRereviewProposals } from "./lib/measurekit/propose.ts"
import { SmokeContext } from "./lib/measurekit/smoke_context.ts"

function main(argv: string[]): number {
  const parser = new ArgumentParser({
    prog: "measure/propose",
    description: "Propose demotions for expired ledger rows.",
    arguments: [
      { flags: ["--model-upgrade"], dest: "model_upgrade", kind: "value", metavar: "MODEL", help: "emit one re-review proposal per active row instead" },
    ],
  })
  const args = parser.parse(argv)
  const ctx = SmokeContext.fromEnvironment()
  const modelUpgrade = args["model_upgrade"] as string | undefined
  const proposals = modelUpgrade
    ? buildRereviewProposals(ctx.countedRows, modelUpgrade)
    : buildExpiryProposals(ctx.countedRows, ctx.metricWindowStart, ctx.today)
  printJson({ proposals })
  return EXIT_OK
}

runMain(main)
