import os from "node:os"

import { errorName, OsError } from "../../measure/lib/measurekit/pyerrors.ts"
import { JsonDecodeError } from "../../measure/lib/measurekit/pyjson.ts"

interface SystemError extends NodeJS.ErrnoException {
  dest?: string
}

interface ErrnoDescription {
  readonly className: string
  readonly strerror: string
}

const ERRNO_DESCRIPTIONS: Record<string, ErrnoDescription> = {
  ENOENT: { className: "FileNotFoundError", strerror: "No such file or directory" },
  EEXIST: { className: "FileExistsError", strerror: "File exists" },
  EACCES: { className: "PermissionError", strerror: "Permission denied" },
  EPERM: { className: "PermissionError", strerror: "Operation not permitted" },
  ENOTDIR: { className: "NotADirectoryError", strerror: "Not a directory" },
  EISDIR: { className: "IsADirectoryError", strerror: "Is a directory" },
  ENOTEMPTY: { className: "OSError", strerror: "Directory not empty" },
  EXDEV: { className: "OSError", strerror: "Invalid cross-device link" },
}
const PYTHON_CLASS_BY_ERRNO_TEXT: [string, string][] = [
  ["[Errno 2]", "FileNotFoundError"],
  ["[Errno 13]", "PermissionError"],
  ["[Errno 20]", "NotADirectoryError"],
  ["[Errno 21]", "IsADirectoryError"],
]

export function describeInternalError(error: unknown): string {
  if (error instanceof JsonDecodeError) return `JSONDecodeError: ${error.message}`
  if (error instanceof OsError) return `${pythonClassOfOsError(error.message)}: ${error.message}`
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const description = typeof code === "string" ? ERRNO_DESCRIPTIONS[code] : undefined
  if (error instanceof Error && description !== undefined) {
    const { path, dest } = error as SystemError
    const errno = os.constants.errno[code as keyof typeof os.constants.errno]
    const files = path === undefined ? "" : `: '${path}'${dest === undefined ? "" : ` -> '${dest}'`}`
    return `${description.className}: [Errno ${errno}] ${description.strerror}${files}`
  }
  return `${errorName(error)}: ${error instanceof Error ? error.message : String(error)}`
}

function pythonClassOfOsError(message: string): string {
  return PYTHON_CLASS_BY_ERRNO_TEXT.find(([prefix]) => message.startsWith(prefix))?.[1] ?? "OSError"
}
