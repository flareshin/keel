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
