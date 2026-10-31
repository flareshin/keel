export class TimeoutExpired extends Error {
  readonly timeoutSeconds: number
  readonly partialStdout: string

  constructor(message: string, timeoutSeconds: number, partialStdout = "") {
    super(message)
    this.name = "TimeoutExpired"
    this.timeoutSeconds = timeoutSeconds
    this.partialStdout = partialStdout
  }
}
