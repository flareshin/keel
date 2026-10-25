import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkoutSnapshot } from '../evidence/gitcmd.ts';
import { readCoverage } from './coverage.ts';
import type { Coverage } from './coverage.ts';
import { runTestFile } from './testfile.ts';

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
const LOCAL_EXCLUDE = join('.git', 'info', 'exclude');

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

export async function runBaseline(directory: string, tests: string[], timeoutSeconds: number): Promise<Baseline> {
  const files: BaselineFile[] = [];
  for (const test of tests) {
    const run = await runBaselineFile(directory, test, timeoutSeconds);
    if (run.outcome !== 'ran') return run;
    files.push(run.file);
  }
  const withPasses = files.filter((file) => file.passed > 0);
  if (withPasses.length === 0) return { outcome: 'empty' };
  return { outcome: 'green', files: withPasses, withoutPasses: files.filter((file) => file.passed === 0).map((file) => file.test) };
}

async function runBaselineFile(directory: string, test: string, timeoutSeconds: number): Promise<FileRun> {
  const coverageDirectory = mkdtempSync(join(tmpdir(), 'keel-precheck-coverage-'));
  try {
    const run = await runTestFile(directory, test, timeoutSeconds, { NODE_V8_COVERAGE: coverageDirectory });
    if (run.outcome === 'timeout') return { outcome: 'timeout', test, output: run.output };
    if (run.returncode !== 0) return { outcome: 'red', test, output: run.output };
    return { outcome: 'ran', file: { test, passed: run.passed, durationMs: run.durationMs, coverage: readCoverage(coverageDirectory, directory) } };
  } finally {
    rmSync(coverageDirectory, { recursive: true, force: true });
  }
}
