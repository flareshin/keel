import childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import { PYTHON_SPACE_PATTERN, decodeReplacing, pyOsErrorMessage, pythonErrnoName, pythonJsonDumps } from './pycompat.ts';
import * as registry from './registry.ts';
import { printErrorLine, writeStdout } from './stdio.ts';
import * as store from './store.ts';
import { OSError, returnCode } from './subprocess.ts';
import { Usage } from './writers.ts';

const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const LINE_START = '(?<![^\\n])';
const SPACE = `[${PYTHON_SPACE_PATTERN.slice(1, -1)}]`;
export const COUNT_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ['surefire', /Tests run: ([0-9]+)/gu],
  ['unittest', new RegExp(`${LINE_START}Ran ([0-9]+) tests?${NOT_WORD_AFTER}`, 'gu')],
  ['tap', new RegExp(`${LINE_START}# pass ([0-9]+)`, 'gu')],
  ['passed', new RegExp(
    `${LINE_START}(?!${SPACE}*Test (?:Files|Suites)${NOT_WORD_AFTER})[^\\n]*?${NOT_WORD_BEFORE}([0-9]+) passed${NOT_WORD_AFTER}`, 'gu')],
];
const NO_TESTS_RECOGNIZED = 4;
const COMMAND_NOT_FOUND = 2;
const DEFAULT_EXEC_PATH = '/bin:/usr/bin';
const KEEPS_SEARCHING_ERRORS = new Set(['ENOENT', 'ENOTDIR']);
const OUTPUT_POLL_MS = 10;
const OUTPUT_READ_BYTES = 64 * 1024;

type Json = Parameters<typeof pythonJsonDumps>[0];

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
  env.appendLogLine('keel-tests.jsonl', {
    ...testRecord, ts: env.iso(env.utcNow()), evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  });
  printErrorLine('KEEL-TEST ' + pythonJsonDumps({
    run_id: runId, count, exit: exitCode, evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  } as Json));
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
  const capture = openCapture();
  try {
    const launched = await launch(argv, cwd, capture);
    if (launched === null) return commandNotFound(argv[0]!);
    return await relayCapture(launched.exited, capture);
  } finally {
    closeSync(capture);
  }
}

function openCapture(): number {
  const directory = mkdtempSync(join(tmpdir(), 'keel-test-'));
  try {
    return openSync(join(directory, 'output'), 'w+', 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function launch(argv: string[], cwd: string, capture: number): Promise<Launched | null> {
  const [name, ...args] = argv as [string, ...string[]];
  let firstHardFailure: NodeJS.ErrnoException | null = null;
  let lastFailure: NodeJS.ErrnoException | null = null;
  for (const candidate of searchCandidates(name)) {
    const attempt = await attemptSpawn(candidate, name, args, cwd, capture);
    if ('child' in attempt) return attempt;
    lastFailure = attempt.failure;
    if (!KEEPS_SEARCHING_ERRORS.has(attempt.failure.code!)) firstHardFailure ??= attempt.failure;
  }
  const failure = (firstHardFailure ?? lastFailure)!;
  if (failure.code === 'ENOENT') return null;
  failure.path = name;
  throw new OSError(pyOsErrorMessage(failure), pythonErrnoName(failure.code));
}

function searchCandidates(name: string): string[] {
  if (name.includes('/')) return [name];
  return (process.env['PATH'] ?? DEFAULT_EXEC_PATH).split(delimiter).map((directory) => {
    if (directory === '') return `./${name}`;
    return directory.endsWith('/') ? directory + name : `${directory}/${name}`;
  });
}

async function attemptSpawn(program: string, argv0: string, args: string[], cwd: string, capture: number): Promise<Attempt> {
  let child: ChildProcess;
  try {
    child = childProcess.spawn(program, args, { cwd, argv0, stdio: ['inherit', capture, capture] });
  } catch (error) {
    return { failure: error as NodeJS.ErrnoException };
  }
  if (child.pid === undefined) return { failure: (await once(child, 'error'))[0] as NodeJS.ErrnoException };
  const exited = new Promise<number>((resolveStatus) => {
    child.on('close', (code, signal) => resolveStatus(returnCode(code, signal)));
  });
  return { child, exited };
}

async function relayCapture(exited: Promise<number>, capture: number): Promise<[exitCode: number, output: string]> {
  const chunks: Buffer[] = [];
  let offset = 0;
  const forwardNewBytes = () => {
    for (;;) {
      const buffer = Buffer.alloc(OUTPUT_READ_BYTES);
      const length = readSync(capture, buffer, 0, buffer.length, offset);
      if (length === 0) return;
      offset += length;
      const chunk = buffer.subarray(0, length);
      writeStdout(chunk);
      chunks.push(chunk);
    }
  };
  let finished = false;
  const status = exited.then((code) => {
    finished = true;
    return code;
  });
  while (!finished) {
    forwardNewBytes();
    await Promise.race([status, sleep(OUTPUT_POLL_MS)]);
  }
  forwardNewBytes();
  return [await status, decodeReplacing(Buffer.concat(chunks))];
}

function commandNotFound(name: string): [exitCode: number, output: string] {
  printErrorLine(`keel test: command not found: ${name}`);
  return [COMMAND_NOT_FOUND, ''];
}
