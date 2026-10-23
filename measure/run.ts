#!/usr/bin/env node
import * as env from "./lib/measurekit/env.ts"
import { ArgumentParser } from "./lib/measurekit/argparse.ts"
import { EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, isoDate, printJson, runMain } from "./lib/measurekit/cli.ts"
import { allRows, loadLedgersFrom } from "./lib/measurekit/ledger.ts"
import { DEFAULT_WINDOW_DAYS, evaluateMetric, FAIL } from "./lib/measurekit/metrics.ts"
import { addDays, todayLocal } from "./lib/measurekit/pydate.ts"
import { pyRepr } from "./lib/measurekit/pyvalue.ts"

function main(argv: string[]): number {
  const parser = new ArgumentParser({
    prog: "measure/run",
    description: "Evaluate one ledger row's metric.",
    arguments: [
      { flags: [], dest: "id", kind: "value", help: "ledger id, e.g. K1 or C-dispatch" },
      { flags: ["--since"], dest: "since", kind: "value", help: `window start (default: today - ${DEFAULT_WINDOW_DAYS} days)`, convert: isoDate },
    ],
  })
  const args = parser.parse(argv)
  const row = allRows(loadLedgersFrom(env.keelHome(), env.overlayDir())).find((candidate) => candidate.id === args["id"])
  if (row === undefined) {
    process.stderr.write(`run: no ledger row with id ${pyRepr(args["id"] as string)}\n`)
    return EXIT_USAGE
  }
  const today = todayLocal()
  const result = evaluateMetric(row, (args["since"] as string | undefined) ?? addDays(today, -DEFAULT_WINDOW_DAYS), today)
  printJson(result)
  return result.status === FAIL ? EXIT_NEGATIVE : EXIT_OK
}

runMain(main)
