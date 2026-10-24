import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkoutTree } from '../evidence/gitcmd.ts';
import { runCaptured, TimeoutExpired } from '../evidence/subprocess.ts';
import { readCoverage } from './coverage.ts';
import type { Coverage } from './coverage.ts';

export interface BaselineFile {
  test: string;
  passed: number;
  durationMs: number;
  coverage: Coverage;
}

export type Baseline =
  | { outcome: 'green'; files: BaselineFile[]; withoutPasses: string[] }
  | { outcome: 'red' | 'timeout'; test: string; output: string }
  | { outcome: 'empty' };

type FileRun = { outcome: 'ran'; file: BaselineFile } | { outcome: 'red' | 'timeout'; test: string; output: string };

const DEPENDENCY_DIRECTORY = 'node_modules';
const PARENT_TEST_RUNNER = 'NODE_TEST_CONTEXT';
const TAP_PASS_COUNT = /^# pass ([0-9]+)$/mu;

export function materializeTree(repo: string, tree: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'keel-precheck-'));
  checkoutTree(repo, tree, directory);
  const dependencies = join(repo, DEPENDENCY_DIRECTORY);
  if (existsSync(dependencies)) symlinkSync(dependencies, join(directory, DEPENDENCY_DIRECTORY));
  return directory;
}

export function runBaseline(directory: string, tests: string[], timeoutSeconds: number): Baseline {
  const files: BaselineFile[] = [];
  for (const test of tests) {
    const run = runTestFile(directory, test, timeoutSeconds);
    if (run.outcome !== 'ran') return run;
    files.push(run.file);
  }
  const withPasses = files.filter((file) => file.passed > 0);
  if (withPasses.length === 0) return { outcome: 'empty' };
  return { outcome: 'green', files: withPasses, withoutPasses: files.filter((file) => file.passed === 0).map((file) => file.test) };
}

function runTestFile(directory: string, test: string, timeoutSeconds: number): FileRun {
  const coverageDirectory = mkdtempSync(join(tmpdir(), 'keel-precheck-coverage-'));
  try {
    const started = performance.now();
    const completed = runCaptured([process.execPath, '--test', '--test-reporter=tap', test], {
      cwd: directory,
      env: { ...withoutParentTestRunner(process.env), NODE_V8_COVERAGE: coverageDirectory },
      timeoutSeconds,
    });
    const durationMs = performance.now() - started;
    const output = completed.stdout.toString() + completed.stderr.toString();
    if (completed.returncode !== 0) return { outcome: 'red', test, output };
    const passed = Number(TAP_PASS_COUNT.exec(completed.stdout.toString())?.[1] ?? 0);
    return { outcome: 'ran', file: { test, passed, durationMs, coverage: readCoverage(coverageDirectory, directory) } };
  } catch (error) {
    if (error instanceof TimeoutExpired) return { outcome: 'timeout', test, output: error.message };
    throw error;
  } finally {
    rmSync(coverageDirectory, { recursive: true, force: true });
  }
}

function withoutParentTestRunner(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [PARENT_TEST_RUNNER]: _parent, ...rest } = env;
  return rest;
}
