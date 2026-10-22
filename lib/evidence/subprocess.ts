import childProcess from 'node:child_process';
import { constants } from 'node:os';
import { pyOsErrorMessage, pyReprList, pythonErrnoName } from './pycompat.ts';

const UNLIMITED_OUTPUT = Infinity;
const SIGNAL_NUMBERS: Record<string, number> = constants.signals;

export class TimeoutExpired extends Error {
  constructor(command: string[], timeoutSeconds: number) {
    super(`Command '${pyReprList(command)}' timed out after ${timeoutSeconds} seconds`);
  }
}

export class OSError extends Error {
  pythonName: string;
  constructor(message: string, pythonName = 'OSError') {
    super(message);
    this.pythonName = pythonName;
  }
}

export interface Completed {
  returncode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutSeconds?: number;
  input?: string;
}

export function runCaptured(command: string[], options: RunOptions = {}): Completed {
  const [program, ...args] = command;
  const completed = childProcess.spawnSync(program!, args, {
    env: options.env,
    cwd: options.cwd,
    input: options.input,
    timeout: options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000,
    maxBuffer: UNLIMITED_OUTPUT,
  });
  if (completed.error) throw spawnFailure(completed.error as NodeJS.ErrnoException, command, options.timeoutSeconds);
  return { returncode: returnCode(completed.status, completed.signal), stdout: completed.stdout, stderr: completed.stderr };
}

export function spawnFailure(error: NodeJS.ErrnoException, command: string[], timeoutSeconds: number | undefined): Error {
  if (error.code === 'ETIMEDOUT') return new TimeoutExpired(command, timeoutSeconds ?? 0);
  return new OSError(pyOsErrorMessage(error), pythonErrnoName(error.code));
}

export function returnCode(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  return -(signal === null ? 0 : (SIGNAL_NUMBERS[signal] ?? 0));
}

