import { ArgumentTypeError, UsageExit } from "./argparse.ts"
import { parseIsoDate } from "./pydate.ts"
import { errorName } from "./pyerrors.ts"
import { pythonJsonDumps } from "./pyjson.ts"
import { pyRepr } from "./pyvalue.ts"

export const EXIT_OK = 0
export const EXIT_NEGATIVE = 1
export const EXIT_USAGE = 2
export const EXIT_INTERNAL = 70

export function runMain(main: (argv: string[]) => number): void {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageExit) {
      process.exitCode = error.code
      return
    }
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n")
    process.stderr.write(`internal error: ${errorName(error)}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT_INTERNAL
  }
}

export function printJson(payload: object): void {
  process.stdout.write(pythonJsonDumps(payload, { sortKeys: true }) + "\n")
}

export function isoDate(value: string): string {
  const parsed = parseIsoDate(value)
  if (parsed === null) throw new ArgumentTypeError(`expected YYYY-MM-DD, got ${pyRepr(value)}`)
  return parsed
}
