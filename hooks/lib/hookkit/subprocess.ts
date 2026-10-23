import { spawnSync } from "node:child_process";
import { constants } from "node:os";

const UNLIMITED_OUTPUT_BYTES = 1 << 30;
const NEWLINES = /\r\n|\r/g;

export interface CompletedProcess {
  returncode: number;
  stdout: string;
  stderr: string;
}

export class OSError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "OSError";
    this.code = code;
  }
}

export class TimeoutExpired extends Error {
  readonly timeoutSeconds: number;

  constructor(command: readonly string[], timeoutSeconds: number) {
    super(`Command '${command.join(" ")}' timed out after ${timeoutSeconds} seconds`);
    this.name = "TimeoutExpired";
    this.timeoutSeconds = timeoutSeconds;
  }
}

export interface RunOptions {
  cwd?: string;
  input?: string;
}

export function run(command: readonly string[], timeoutSeconds: number, options: RunOptions = {}): CompletedProcess {
  const [program, ...args] = command;
  if (program === undefined) throw new OSError("empty command", undefined);
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: UNLIMITED_OUTPUT_BYTES,
    ...options,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new TimeoutExpired(command, timeoutSeconds);
    throw new OSError(result.error.message, code);
  }
  const returncode = result.status ?? -(constants.signals[result.signal as keyof typeof constants.signals] ?? 0);
  return {
    returncode,
    stdout: result.stdout.replace(NEWLINES, "\n"),
    stderr: result.stderr.replace(NEWLINES, "\n"),
  };
}
