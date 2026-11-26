import childProcess, { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readJsonl } from '../../measure/lib/measurekit/datafiles.ts';
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
const NOT_IN_TAP_LINE = '(?<!(?<![^\\r\\n])[ \\t]*(?:#|(?:not )?ok)(?:[ \\t][^\\r\\n]*)?)';
const TEST_FILES_LINE = `${SPACE_EITHER_WAY}*Test (?:Files|Suites)${NOT_WORD_AFTER}`;
export const COUNT_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ['surefire', /Tests run: ([0-9]+)/gu],
  ['unittest', new RegExp(`${LINE_START}Ran ([0-9]+) tests?${NOT_WORD_AFTER}`, 'gu')],
  ['tap', new RegExp(`${LINE_START}# pass ([0-9]+)`, 'gu')],
  ['spec', new RegExp(`${LINE_START}\u2139 pass ([0-9]+)${NOT_WORD_AFTER}`, 'gu')],
];
const SUREFIRE_RESULTS_HEADING = new RegExp(`${LINE_START}(?:\\[[A-Z]+\\] )?Results ?:\\r?$`, 'gmu');
const FAILURE_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ['surefire', /Tests run: [0-9]+, Failures: ([0-9]+), Errors: ([0-9]+)/gu],
  ['unittest', new RegExp(`${LINE_START}FAILED \\((?:failures=([0-9]+))?(?:, )?(?:errors=([0-9]+))?`, 'gu')],
  ['tap', new RegExp(`${LINE_START}# fail ([0-9]+)${NOT_WORD_AFTER}`, 'gu')],
  ['spec', new RegExp(`${LINE_START}\u2139 fail ([0-9]+)${NOT_WORD_AFTER}`, 'gu')],
];
const TALLY_WORDS = '[a-z]+(?: [a-z]+)*';
const TALLY = `[0-9]+ ${TALLY_WORDS}`;
const TALLY_PARTS = new RegExp(`([0-9]+) (${TALLY_WORDS})`, 'gu');
const LINE_END = '\\r?$';
const RUNNER_SUMMARY_SHAPES = [
  { heading: '(?:=+ )?', tallies: `${TALLY}(?:, ${TALLY})*`, ending: ' in [0-9.]+s(?: \\([0-9:]+\\))?(?: =+)?' },
  { heading: 'Tests:[ \\t]+', tallies: `${TALLY}(?:, ${TALLY})*`, ending: ', [0-9]+ total' },
  { heading: 'Tests[ \\t]+', tallies: `${TALLY}(?: \\| ${TALLY})*`, ending: ' \\([0-9]+\\)' },
];
const OUTSIDE_TAP_LINE = new RegExp(NOT_IN_TAP_LINE, 'uy');
const TAP_SEGMENT_END = /\r/gu;
const RUNNER_SUMMARY_LINES = RUNNER_SUMMARY_SHAPES.map((shape) => ({
  ending: new RegExp(`${shape.ending}${LINE_END}`, 'mu'),
  start: new RegExp(`${NOT_WORD_BEFORE}(?=${shape.heading}[0-9])`, 'gu'),
  run: new RegExp(`${shape.heading}${shape.tallies}`, 'uy'),
  summary: new RegExp(`${shape.heading}(${shape.tallies})${shape.ending}${LINE_END}`, 'muy'),
}));
const SUMMARY_FRAMEWORK = 'passed';
const PASSED_TALLIES = new Set(['passed']);
const FAILED_TALLIES = new Set(['failed', 'error', 'errors']);
const FILE_FAILURES = new RegExp(
  `${LINE_START}${TEST_FILES_LINE}[^\\n]*?${NOT_WORD_BEFORE}([0-9]+) failed${NOT_WORD_AFTER}`, 'gu');
export const NO_TESTS_RECOGNIZED = 4;
export const FAILURES_RECOGNIZED = 6;
const KEEL_EXITS = { passed: 0, no_tests_recognized: NO_TESTS_RECOGNIZED, failures_recognized: FAILURES_RECOGNIZED, tree_changed: 7, output_stayed_open: 8 };
type Outcome = keyof typeof KEEL_EXITS | 'command_failed';
const COMMAND_NOT_FOUND = 2;
const DEFAULT_EXEC_PATH = '/bin:/usr/bin';
const MKFIFO = '/usr/bin/mkfifo';
const KEEPS_SEARCHING_ERRORS = new Set(['ENOENT', 'ENOTDIR']);
const CAT = '/bin/cat';
const DEFAULT_OUTPUT_IDLE_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
const TESTS_LOG = 'keel-tests.jsonl';

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
  const { exitCode, output, outputStayedOpen } = await stream(argv, cwd);
  const after = gitcmd.snapshotTree(repoRoot);
  const submodulesAfter = submoduleSnapshots(repoRoot);
  const [count, framework] = recognize(output);
  const failures = recognizeFailures(output);
  const outcome = outcomeOf({ exitCode, outputStayedOpen, failures, count, treeChanged: before !== after });
  const keelExit = outcome === 'command_failed' ? exitCode : KEEL_EXITS[outcome];
  const testRecord = { run_id: runId, repo: repoKey, repo_root: repoRoot, cmd: argv, exit: exitCode, count, framework, tree: after };
  let evidenceId: string | null = null;
  let submoduleEvidence: Record<string, string> = {};
  if (outcome === 'passed') {
    const evidence = store.write('tests', { ...testRecord, head: gitcmd.commitSha(repoRoot, 'HEAD') }, repoKey);
    evidenceId = evidence.evidence_id;
    submoduleEvidence = writeSubmoduleEvidence(testRecord, submodulesBefore, submodulesAfter);
  }
  const flakySignal = evidenceId === null ? null : earlierFailureOnSameTree(testRecord);
  if (flakySignal !== null) printErrorLine(`keel test: [K3] warn: run ${flakySignal} of this command failed on this same tree and it passes now with no change; that is a flaky signal, so find what makes the test nondeterministic instead of rerunning it until it passes`);
  env.appendRecord(TESTS_LOG, {
    ...testRecord, keel_exit: keelExit, ts: env.iso(env.utcNow()), evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
    ...(flakySignal === null ? {} : { passed_after_failure: flakySignal }),
  });
  if (outcome === 'failures_recognized') printErrorLine(`keel test: the output reports ${failures} failing test${failures === 1 ? '' : 's'} or test file${failures === 1 ? '' : 's'} although the command exited 0; no evidence written`);
  if (outcome === 'tree_changed') printErrorLine('keel test: the working tree changed while the command ran; no evidence written');
  printErrorLine('KEEL-TEST ' + JSON.stringify({
    run_id: runId, count, exit: exitCode, evidence_id: evidenceId, submodule_evidence: submoduleEvidence,
  }));
  return keelExit;
}

function outcomeOf(run: { exitCode: number; outputStayedOpen: boolean; failures: number; count: number; treeChanged: boolean }): Outcome {
  if (run.exitCode !== 0) return 'command_failed';
  if (run.failures > 0) return 'failures_recognized';
  if (run.outputStayedOpen) return 'output_stayed_open';
  if (run.count === 0) return 'no_tests_recognized';
  if (run.treeChanged) return 'tree_changed';
  return 'passed';
}

function earlierFailureOnSameTree(run: { repo_root: string; tree: string; cmd: string[] }): string | null {
  const sameCommand = JSON.stringify(run.cmd);
  const failure = readJsonl(join(env.logsDir(), TESTS_LOG)).records
    .findLast((earlier) => earlier.repo_root === run.repo_root && earlier.tree === run.tree
      && JSON.stringify(earlier.cmd) === sameCommand && typeof earlier.count === 'number' && earlier.count > 0
      && testsFailed(earlier) && typeof earlier.run_id === 'string');
  return typeof failure?.run_id === 'string' ? failure.run_id : null;
}

function testsFailed(earlier: { exit?: unknown; keel_exit?: unknown }): boolean {
  return earlier.exit !== 0 || earlier.keel_exit === FAILURES_RECOGNIZED;
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
    const lines = [...output.matchAll(pattern)];
    if (lines.length === 0) continue;
    framework ??= name;
    total += name === 'surefire' ? surefireTotal(output, lines) : lines.reduce((sum, line) => sum + Number(line[1]), 0);
  }
  const passed = summaryTallies(output, PASSED_TALLIES);
  if (passed.length > 0) {
    framework ??= SUMMARY_FRAMEWORK;
    total += passed.reduce((sum, item) => sum + item, 0);
  }
  return [total, framework];
}

function surefireTotal(output: string, testsRunLines: RegExpExecArray[]): number {
  const resultsTotals = new Set([...output.matchAll(SUREFIRE_RESULTS_HEADING)]
    .map((heading) => testsRunLines.find((line) => line.index > heading.index))
    .filter((line) => line !== undefined));
  const totals = resultsTotals.size > 0 ? [...resultsTotals] : [testsRunLines.at(-1)!];
  return totals.reduce((sum, line) => sum + Number(line[1]), 0);
}

export function recognizeFailures(output: string): number {
  let total = summaryTallies(output, FAILED_TALLIES).reduce((sum, item) => sum + item, 0);
  for (const [name, pattern] of FAILURE_PATTERNS) {
    const counts = [...output.matchAll(pattern)].map((match) => failuresOf(name, match));
    if (counts.length === 0) continue;
    total += name === 'surefire' ? Math.max(...counts) : counts.reduce((sum, item) => sum + item, 0);
  }
  const failedFiles = [...output.matchAll(FILE_FAILURES)].reduce((sum, match) => sum + Number(match[1]), 0);
  return Math.max(total, failedFiles);
}

function summaryTallies(output: string, outcomes: ReadonlySet<string>): number[] {
  const lines = output.split('\n');
  return RUNNER_SUMMARY_LINES.flatMap((shape) => lines.filter((line) => shape.ending.test(line)).map((line) => firstSummary(line, shape)))
    .filter((summary) => summary !== null)
    .flatMap((summary) => [...summary[1]!.matchAll(TALLY_PARTS)])
    .filter((tally) => outcomes.has(tally[2]!.split(' ').at(-1)!))
    .map((tally) => Number(tally[1]));
}

function firstSummary(line: string, shape: (typeof RUNNER_SUMMARY_LINES)[number]): RegExpExecArray | null {
  shape.start.lastIndex = 0;
  for (let start = shape.start.exec(line); start !== null; start = shape.start.exec(line)) {
    shape.summary.lastIndex = start.index;
    const summary = shape.summary.exec(line);
    if (summary === null) {
      shape.run.lastIndex = start.index;
      shape.run.exec(line);
      shape.start.lastIndex = Math.max(shape.run.lastIndex, start.index + 1);
    } else if (outsideTapLine(line, start.index)) {
      return summary;
    } else {
      shape.start.lastIndex = outsideTapLine(line, start.index + 1) ? start.index + 1 : tapSegmentEnd(line, start.index);
    }
  }
  return null;
}

function outsideTapLine(line: string, index: number): boolean {
  OUTSIDE_TAP_LINE.lastIndex = index;
  return OUTSIDE_TAP_LINE.test(line);
}

function tapSegmentEnd(line: string, index: number): number {
  TAP_SEGMENT_END.lastIndex = index;
  return TAP_SEGMENT_END.exec(line)?.index ?? line.length;
}

function failuresOf(framework: string, match: RegExpMatchArray): number {
  const failed = Number(match[1] ?? 0) + Number(match[2] ?? 0);
  return framework === 'unittest' ? Math.max(failed, 1) : failed;
}

interface Launched {
  child: ChildProcess;
  exited: Promise<number>;
}

type Attempt = Launched | { failure: NodeJS.ErrnoException };

interface Streamed {
  exitCode: number;
  output: string;
  outputStayedOpen: boolean;
}

async function stream(argv: string[], cwd: string): Promise<Streamed> {
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
    const openerWithoutWriter = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const writer = openSync(fifo, constants.O_WRONLY);
    const blockingReader = openSync(fifo, constants.O_RDONLY);
    closeSync(openerWithoutWriter);
    return { reader: blockingReader, writer };
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

async function relayUntilClosed(exited: Promise<number>, reader: number): Promise<Streamed> {
  const relay = childProcess.spawn(CAT, [], { stdio: [reader, 'pipe', 'inherit'] });
  const chunks: Buffer[] = [];
  const idleLimitMs = outputIdleLimitMs();
  let commandExited = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    if (commandExited) idleTimer = setTimeout(() => relay.kill('SIGKILL'), idleLimitMs);
  };
  relay.stdout!.on('data', (chunk: Buffer) => {
    writeStdout(chunk);
    chunks.push(chunk);
    restartIdleTimer();
  });
  const relayClosed = once(relay, 'close');
  const exitCode = await exited;
  commandExited = true;
  restartIdleTimer();
  const [, relaySignal] = await relayClosed;
  clearTimeout(idleTimer);
  const output = Buffer.concat(chunks).toString();
  const outputStayedOpen = relaySignal === 'SIGKILL';
  if (outputStayedOpen) printErrorLine(`keel test: the command exited but its output stayed open and silent for ${idleLimitMs} ms; no evidence written`);
  return { exitCode, output, outputStayedOpen };
}

function outputIdleLimitMs(): number {
  const configured = Number(process.env['KEEL_TEST_OUTPUT_IDLE_MS']);
  return Number.isInteger(configured) && configured > 0 && configured <= MAX_TIMER_MS ? configured : DEFAULT_OUTPUT_IDLE_MS;
}

function commandNotFound(name: string): Streamed {
  printErrorLine(`keel test: command not found: ${name}`);
  return { exitCode: COMMAND_NOT_FOUND, output: '', outputStayedOpen: false };
}
