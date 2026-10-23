import { errorName } from "../../measure/lib/measurekit/cli.ts"

export function describeInternalError(error: unknown): string {
  return `${errorName(error)}: ${error instanceof Error ? error.message : String(error)}`
}
