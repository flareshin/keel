#!/usr/bin/env node
import * as env from "./lib/measurekit/env.ts"
import {
  dateOption, EXIT_NEGATIVE, EXIT_OK, EXIT_USAGE, exactlyOnePositional, parseCommandLine, printJson, runMain, stringOption,
} from "./lib/measurekit/cli.ts"
import type { CommandSpec } from "./lib/measurekit/cli.ts"
import { addDays, todayLocal } from "./lib/measurekit/dates.ts"
import { allRows, loadLedgersFrom } from "./lib/measurekit/ledger.ts"
import { DEFAULT_WINDOW_DAYS, evaluateMetric, FAIL } from "./lib/measurekit/metrics.ts"

const COMMAND: CommandSpec = {
  prog: "measure/run",
  usage: "measure/run [-h] [--since YYYY-MM-DD] ID",
  description: "Evaluate one ledger row's metric.",
  argumentHelp: [
    ["ID", "ledger id, e.g. K1 or C-dispatch"],
    ["--since YYYY-MM-DD", `window start (default: today - ${DEFAULT_WINDOW_DAYS} days)`],
  ],
  options: { since: { type: "string" } },
}

function main(argv: string[]): number {
  const parsed = parseCommandLine(COMMAND, argv)
  const id = exactlyOnePositional(COMMAND, parsed, "ID")
  const since = dateOption(COMMAND, "--since", stringOption(parsed, "since"))
  const row = allRows(loadLedgersFrom(env.keelHome(), env.overlayDir())).find((candidate) => candidate.id === id)
  if (row === undefined) {
    process.stderr.write(`run: no ledger row with id ${JSON.stringify(id)}\n`)
    return EXIT_USAGE
  }
  const today = todayLocal()
  const result = evaluateMetric(row, since ?? addDays(today, -DEFAULT_WINDOW_DAYS), today)
  printJson(result)
  return result.status === FAIL ? EXIT_NEGATIVE : EXIT_OK
}

runMain(main)
