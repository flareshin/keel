import childProcess from 'node:child_process';
import { constants } from 'node:os';

const UNLIMITED_OUTPUT = Infinity;
const SIGNAL_NUMBERS: Record<string, number> = constants.signals;

export class TimeoutExpired extends Error {
  override name = 'TimeoutExpired';

  constructor(command: string[], timeoutSeconds: number) {
    super(`Command ${JSON.stringify(command)} timed out after ${timeoutSeconds} seconds`);
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

const UNENCODABLE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udc7f\udd00-\udfff]/;

export class UnicodeEncodeError extends Error {
  override name = 'UnicodeEncodeError';
}

function rejectUnencodable(command: string[]): void {
  for (const word of command) {
    const found = UNENCODABLE_SURROGATE.exec(word);
    if (found === null) continue;
    const position = Array.from(word.slice(0, found.index)).length;
    const digits = found[0].charCodeAt(0).toString(16).padStart(4, '0');
    throw new UnicodeEncodeError(`'utf-8' codec can't encode character '\\u${digits}' in position ${position}: surrogates not allowed`);
  }
}

export function runCaptured(command: string[], options: RunOptions = {}): Completed {
  rejectUnencodable(command);
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

export function runProcessGroup(command: string[], options: Omit<RunOptions, 'input'> = {}): Promise<Completed> {
  rejectUnencodable(command);
  const [program, ...args] = command;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(program!, args, { env: options.env, cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    const timer = options.timeoutSeconds === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try {
        killGroup(child.pid!);
      } catch (error) {
        reject(error);
      }
    }, options.timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new TimeoutExpired(command, options.timeoutSeconds ?? 0));
      else resolve({ returncode: returnCode(status, signal), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function killGroup(leader: number): void {
  try {
    process.kill(-leader, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function spawnFailure(error: NodeJS.ErrnoException, command: string[], timeoutSeconds: number | undefined): Error {
  return error.code === 'ETIMEDOUT' ? new TimeoutExpired(command, timeoutSeconds ?? 0) : error;
}

export function returnCode(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  return -(signal === null ? 0 : (SIGNAL_NUMBERS[signal] ?? 0));
}

