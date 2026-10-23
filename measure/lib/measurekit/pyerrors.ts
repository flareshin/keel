export class ValueError extends Error {}

export class OsError extends Error {
  readonly pythonClass: string

  constructor(message: string, pythonClass = "OSError") {
    super(message)
    this.pythonClass = pythonClass
  }
}

export function isOsError(error: unknown): boolean {
  if (error instanceof OsError) return true
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).syscall !== undefined
}

export function errorName(error: unknown): string {
  if (error instanceof OsError) return error.pythonClass
  return error instanceof Error ? error.constructor.name : typeof error
}
