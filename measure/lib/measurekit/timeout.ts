export class TimeoutExpired extends Error {
  readonly timeoutSeconds: number
  readonly partialStdout: string
  readonly partialStderr: string

  constructor(message: string, timeoutSeconds: number, partialStdout = "", partialStderr = "") {
    super(message)
    this.name = "TimeoutExpired"
    this.timeoutSeconds = timeoutSeconds
    this.partialStdout = partialStdout
    this.partialStderr = partialStderr
  }
}
