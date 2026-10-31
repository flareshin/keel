import childProcess, { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import * as registry from './registry.ts';
import { printErrorLine, writeStdout } from './stdio.ts';
import * as store from './store.ts';
import { returnCode } from './subprocess.ts';
import { SPACE_EITHER_WAY } from './text.ts';
import { Usage } from './writers.ts';

const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const LINE_START = '(?<![^\\n])';
const NOT_IN_TAP_DIAGNOSTIC = '(?<!(?<![^\\r\\n])[ \\t]*#(?:[ \\t][^\\r\\n]*)?)';
export const COUNT_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ['surefire', /Tests run: ([0-9]+)/gu],
  ['unittest', new RegExp(`${LINE_START}Ran ([0-9]+) tests?${NOT_WORD_AFTER}`, 'gu')],
  ['tap', new RegExp(`${LINE_START}# pass ([0-9]+)`, 'gu')],
  ['spec', new RegExp(`${LINE_START}\u2139 pass ([0-9]+)${NOT_WORD_AFTER}`, 'gu')],
  ['passed', new RegExp(
    `${LINE_START}(?!${SPACE_EITHER_WAY}*Test (?:Files|Suites)${NOT_WORD_AFTER})[^\\n]*?${NOT_WORD_BEFORE}${NOT_IN_TAP_DIAGNOSTIC}([0-9]+) passed${NOT_WORD_AFTER}`, 'gu')],
];
export const NO_TESTS_RECOGNIZED = 4;
const COMMAND_NOT_FOUND = 2;
const DEFAULT_EXEC_PATH = '/bin:/usr/bin';
const MKFIFO = '/usr/bin/mkfifo';
const KEEPS_SEARCHING_ERRORS = new Set(['ENOENT', 'ENOTDIR']);
const OUTPUT_POLL_MS = 10;
const OUTPUT_READ_BYTES = 64 * 1024;

export async function run(argv: string[], cwd: string): Promise<number> {
  if (argv.length === 0) throw new Usage('keel test -- <command…>');
  const repoRoot = gitcmd.toplevel(cwd);
  if (repoRoot === null) throw new Usage('keel test must run inside a git repository');
  const repoKey = registry.originKey(repoRoot);
  if (repoKey === null) throw new Usage('the repository needs an origin remote');
  const now = env.utcNow();
  const runId = env.newId('tr', now, env.RUN_ID_RANDOM_BYTES);
  const before = gitcmd.snapshotTree(repoRoot);
  const submodulesBefore = submoduleSnapshots(repoRoot);
  const [exitCode, output] = await stream(argv, cwd);
  const after = gitcmd.snapshotTree(repoRoot);
  const submodulesAfter = submoduleSnapshots(repoRoot);
  const [count, framework] = recognize(output);
  const testRecord = { run_id: runId, repo: repoKey, repo_root: repoRoot, cmd: argv, exit: exitCode, count, framework, tree: after };
  let evidenceId: string | null = null;
  let submoduleEvidence: Record<string, string> = {};
  if (exitCode === 0 && count > 0 && before === after) {
    const evidence = store.write('tests', { ...testRecord, head: gitcmd.commitSha(repoRoot, 'HEAD') }, repoKey);
    evidenceId = evidence.evidence_id;
    submoduleEvidence = writeSubmoduleEvidence(testRecord, submodulesBefore, submodulesAfter);
  }
  env.appendRecord('keel-tests.jsonl', {
    ...testRecord, ts: env.iso(env.utcNow()), evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  });
  printErrorLine('KEEL-TEST ' + JSON.stringify({
    run_id: runId, count, exit: exitCode, evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  }));
  if (exitCode === 0 && count === 0) return NO_TESTS_RECOGNIZED;
  return exitCode;
}

function submoduleSnapshots(repoRoot: string): Map<string, string> {
  return new Map(gitcmd.submoduleRoots(repoRoot).map((root) => [root, gitcmd.snapshotTree(root)]));
}

function writeSubmoduleEvidence(testRecord: { repo: string }, before: Map<string, string>, after: Map<string, string>): Record<string, string> {
  const written: Record<string, string> = {};
  for (const [root, tree] of after) {
    const repoKey = registry.originKey(root);
    if (repoKey === null || before.get(root) !== tree) continue;
    const evidence = store.write('tests', {
      ...testRecord, repo: repoKey, repo_root: root, tree, head: gitcmd.commitSha(root, 'HEAD'), superproject: testRecord.repo,
    } as { [key: string]: any }, repoKey);
    written[repoKey] = evidence.evidence_id;
  }
  return written;
}

export function recognize(output: string): [count: number, framework: string | null] {
  let total = 0;
  let framework: string | null = null;
  for (const [name, pattern] of COUNT_PATTERNS) {
    const counts = [...output.matchAll(pattern)].map((match) => Number(match[1]));
    if (counts.length === 0) continue;
    framework ??= name;
    total += name === 'surefire' ? counts.at(-1)! : counts.reduce((sum, item) => sum + item, 0);
  }
  return [total, framework];
}

interface Launched {
  child: ChildProcess;
  exited: Promise<number>;
}

type Attempt = Launched | { failure: NodeJS.ErrnoException };

async function stream(argv: string[], cwd: string): Promise<[exitCode: number, output: string]> {
  const pipe = openOutputPipe();
  try {
    let launched: Launched | null;
    try {
      launched = await launch(argv, cwd, pipe.writer);
    } finally {
      closeSync(pipe.writer);
    }
    if (launched === null) return commandNotFound(argv[0]!);
    return await relayUntilClosed(launched.exited, pipe.reader);
  } finally {
    closeSync(pipe.reader);
  }
}

function openOutputPipe(): { reader: number; writer: number } {
  const directory = mkdtempSync(join(tmpdir(), 'keel-test-'));
  try {
    const fifo = join(directory, 'output');
    const made = spawnSync(MKFIFO, ['-m', '600', fifo], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.error?.message ?? made.stderr}`);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    return { reader, writer: openSync(fifo, constants.O_WRONLY) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function launch(argv: string[], cwd: string, writer: number): Promise<Launched | null> {
  const [name, ...args] = argv as [string, ...string[]];
  let firstHardFailure: NodeJS.ErrnoException | null = null;
  let lastFailure: NodeJS.ErrnoException | null = null;
  for (const candidate of searchCandidates(name)) {
    const attempt = await attemptSpawn(candidate, name, args, cwd, writer);
    if ('child' in attempt) return attempt;
    lastFailure = attempt.failure;
    if (!KEEPS_SEARCHING_ERRORS.has(attempt.failure.code!)) firstHardFailure ??= attempt.failure;
  }
  const failure = (firstHardFailure ?? lastFailure)!;
  if (failure.code === 'ENOENT') return null;
  throw new Error(`cannot run ${name}: ${failure.message}`, { cause: failure });
}

function searchCandidates(name: string): string[] {
  if (name.includes('/')) return [name];
  return (process.env['PATH'] ?? DEFAULT_EXEC_PATH).split(delimiter).map((directory) => {
    if (directory === '') return `./${name}`;
    return directory.endsWith('/') ? directory + name : `${directory}/${name}`;
  });
}

async function attemptSpawn(program: string, argv0: string, args: string[], cwd: string, writer: number): Promise<Attempt> {
  let child: ChildProcess;
  try {
    child = childProcess.spawn(program, args, { cwd, argv0, stdio: ['inherit', writer, writer] });
  } catch (error) {
    return { failure: error as NodeJS.ErrnoException };
  }
  if (child.pid === undefined) return { failure: (await once(child, 'error'))[0] as NodeJS.ErrnoException };
  const exited = new Promise<number>((resolveStatus) => {
    child.on('close', (code, signal) => resolveStatus(returnCode(code, signal)));
  });
  return { child, exited };
}

async function relayUntilClosed(exited: Promise<number>, reader: number): Promise<[exitCode: number, output: string]> {
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = readAvailable(reader);
    if (chunk === 'pending') {
      await sleep(OUTPUT_POLL_MS);
    } else if (chunk.length === 0) {
      break;
    } else {
      writeStdout(chunk);
      chunks.push(chunk);
    }
  }
  return [await exited, Buffer.concat(chunks).toString()];
}

function readAvailable(reader: number): Buffer | 'pending' {
  const buffer = Buffer.alloc(OUTPUT_READ_BYTES);
  try {
    return buffer.subarray(0, readSync(reader, buffer, 0, buffer.length, null));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return 'pending';
    throw error;
  }
}

function commandNotFound(name: string): [exitCode: number, output: string] {
  printErrorLine(`keel test: command not found: ${name}`);
  return [COMMAND_NOT_FOUND, ''];
}
