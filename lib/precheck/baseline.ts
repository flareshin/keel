import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkoutSnapshot } from '../evidence/gitcmd.ts';
import { readCoverage } from './coverage.ts';
import type { Coverage } from './coverage.ts';
import { readTracedPaths, readTraceEnv } from './readtrace.ts';
import { runTestFile } from './testfile.ts';

export interface BaselineFile {
  test: string;
  passed: number;
  durationMs: number;
  loadFactor: number;
  coverage: Coverage;
  reads: Set<string>;
}

export type Baseline =
  | { outcome: 'green'; files: BaselineFile[]; withoutPasses: string[]; notRun: string[]; timeoutSeconds: number }
  | { outcome: 'red'; test: string; output: string }
  | { outcome: 'timeout'; test: string; output: string; timeoutSeconds: number }
  | { outcome: 'budget'; notRun: string[] }
  | { outcome: 'empty' };

type FileRun = { outcome: 'ran'; file: BaselineFile } | Extract<Baseline, { outcome: 'red' | 'timeout' }>;

export const DEFAULT_BASELINE_BUDGET_MS = 15 * 60 * 1000;
const IDLE_TIMEOUT_SECONDS = 900;
const MAX_LOAD_FACTOR = 8;
const DEPENDENCY_DIRECTORY = 'node_modules';
const LOCAL_EXCLUDE = join('.git', 'info', 'exclude');
const READ_LOG_FILE = 'reads.log';

export function baselineTimeoutSeconds(load: number, cpus: number): number {
  return Math.round(IDLE_TIMEOUT_SECONDS * loadFactor(load, cpus));
}

export function loadFactor(load: number, cpus: number): number {
  return Math.min(Math.max(load / cpus, 1), MAX_LOAD_FACTOR);
}

export function currentLoadFactor(): number {
  return loadFactor(loadavg()[0]!, availableParallelism());
}

export function materializeTree(repo: string, tree: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'keel-precheck-'));
  try {
    checkoutSnapshot(repo, tree, directory);
    linkDependencies(repo, directory);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function linkDependencies(repo: string, directory: string): void {
  const dependencies = join(repo, DEPENDENCY_DIRECTORY);
  if (!existsSync(dependencies)) return;
  symlinkSync(dependencies, join(directory, DEPENDENCY_DIRECTORY));
  mkdirSync(dirname(join(directory, LOCAL_EXCLUDE)), { recursive: true });
  appendFileSync(join(directory, LOCAL_EXCLUDE), `/${DEPENDENCY_DIRECTORY}\n`);
}

export async function runBaseline(directory: string, tests: string[], timeoutSeconds: number, sampleLoadFactor: () => number = currentLoadFactor, budgetMs = DEFAULT_BASELINE_BUDGET_MS): Promise<Baseline> {
  const started = performance.now();
  const files: BaselineFile[] = [];
  let firstLoadFactor: number | undefined;
  for (const [index, test] of tests.entries()) {
    if (index > 0 && performance.now() - started >= budgetMs) return finishedBaseline(files, tests.slice(index), timeoutSeconds);
    const loadFactor = sampleLoadFactor();
    firstLoadFactor ??= loadFactor;
    const run = await runBaselineFile(directory, test, timeoutSeconds * Math.max(loadFactor / firstLoadFactor, 1), loadFactor);
    if (run.outcome !== 'ran') return run;
    files.push(run.file);
  }
  return finishedBaseline(files, [], timeoutSeconds);
}

function finishedBaseline(files: BaselineFile[], notRun: string[], timeoutSeconds: number): Baseline {
  const withPasses = files.filter((file) => file.passed > 0);
  if (withPasses.length === 0) return notRun.length > 0 ? { outcome: 'budget', notRun } : { outcome: 'empty' };
  return { outcome: 'green', files: withPasses, withoutPasses: files.filter((file) => file.passed === 0).map((file) => file.test), notRun, timeoutSeconds };
}

async function runBaselineFile(directory: string, test: string, timeoutSeconds: number, loadFactor: number): Promise<FileRun> {
  const coverageDirectory = mkdtempSync(join(tmpdir(), 'keel-precheck-coverage-'));
  try {
    const readLog = join(coverageDirectory, READ_LOG_FILE);
    const run = await runTestFile(directory, test, timeoutSeconds, { NODE_V8_COVERAGE: coverageDirectory, ...readTraceEnv(readLog) });
    if (run.outcome === 'timeout') return { outcome: 'timeout', test, output: run.output, timeoutSeconds };
    if (run.returncode !== 0) return { outcome: 'red', test, output: run.output };
    return { outcome: 'ran', file: { test, passed: run.passed, durationMs: run.durationMs, loadFactor, coverage: readCoverage(coverageDirectory, directory), reads: readTracedPaths(readLog, directory) } };
  } finally {
    rmSync(coverageDirectory, { recursive: true, force: true });
  }
}
