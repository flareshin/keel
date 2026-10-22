import { toOsError } from "../../measure/lib/measurekit/pyerrno.ts"
import { errorName, OsError } from "../../measure/lib/measurekit/pyerrors.ts"
import { JsonDecodeError } from "../../measure/lib/measurekit/pyjson.ts"

export function describeInternalError(error: unknown): string {
  if (error instanceof JsonDecodeError) return `JSONDecodeError: ${error.message}`
  const osError = error instanceof OsError ? error : toOsError(error)
  if (osError !== undefined) return `${osError.pythonClass}: ${osError.message}`
  return `${errorName(error)}: ${error instanceof Error ? error.message : String(error)}`
}
