import { UsageExit } from "../../measure/lib/measurekit/cli.ts";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function emit(result: CommandResult): void {
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

export function parseOrExit<T>(parse: () => T): T | CommandResult {
  try {
    return parse();
  } catch (error) {
    if (error instanceof UsageExit) return { code: error.code, stdout: "", stderr: "" };
    throw error;
  }
}

export function isCommandResult(value: object): value is CommandResult {
  return "code" in value && "stdout" in value && "stderr" in value;
}
