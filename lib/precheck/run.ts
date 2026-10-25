import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BaselineFile } from './baseline.ts';
import { applyMutant, parsesCleanly } from './mutants.ts';
import type { Mutant } from './mutants.ts';
import { runTestFile } from './testfile.ts';

export interface MutantTarget {
  path: string;
  mutant: Mutant;
}

export type MutantVerdict =
  | { outcome: 'killed'; test: string }
  | { outcome: 'survived'; ran: string[] }
  | { outcome: 'no test reaches' }
  | { outcome: 'invalid'; reason: 'syntax' }
  | { outcome: 'invalid'; reason: 'no tests ran'; test: string }
  | { outcome: 'timeout'; test: string };

export interface MutantResult extends MutantTarget {
  coverage: 'known' | 'unknown';
  verdict: MutantVerdict;
}

export interface MutationRun {
  results: MutantResult[];
  notRun: MutantTarget[];
}

export const DEFAULT_BUDGET_MS = 15 * 60 * 1000;
const TIMEOUT_FACTOR = 1.5;
const TIMEOUT_SLACK_MS = 5000;

export async function runMutants(directory: string, baseline: BaselineFile[], targets: MutantTarget[], budgetMs = DEFAULT_BUDGET_MS): Promise<MutationRun> {
  const started = performance.now();
  const fastestFirst = [...baseline].sort((a, b) => a.durationMs - b.durationMs);
  const results: MutantResult[] = [];
  for (const [index, target] of targets.entries()) {
    if (performance.now() - started >= budgetMs) return { results, notRun: targets.slice(index) };
    results.push(await runMutant(directory, fastestFirst, target));
  }
  return { results, notRun: [] };
}

async function runMutant(directory: string, files: BaselineFile[], target: MutantTarget): Promise<MutantResult> {
  const known = files.some((file) => file.coverage.seen.has(target.path));
  const selected = known ? files.filter((file) => file.coverage.executedLines.get(target.path)?.has(target.mutant.line)) : files;
  return { ...target, coverage: known ? 'known' : 'unknown', verdict: await verdictFor(directory, selected, target) };
}

async function verdictFor(directory: string, selected: BaselineFile[], target: MutantTarget): Promise<MutantVerdict> {
  if (selected.length === 0) return { outcome: 'no test reaches' };
  const path = join(directory, target.path);
  const original = readFileSync(path, 'utf8');
  const mutated = applyMutant(original, target.mutant);
  if (!parsesCleanly(target.path, mutated)) return { outcome: 'invalid', reason: 'syntax' };
  writeFileSync(path, mutated);
  try {
    return await firstFailure(directory, selected);
  } finally {
    writeFileSync(path, original);
  }
}

async function firstFailure(directory: string, selected: BaselineFile[]): Promise<MutantVerdict> {
  const ran: string[] = [];
  for (const file of selected) {
    const run = await runTestFile(directory, file.test, timeoutSecondsFor(file));
    if (run.outcome === 'timeout') return { outcome: 'timeout', test: file.test };
    if (run.returncode !== 0) return { outcome: 'killed', test: file.test };
    if (run.passed === 0) return { outcome: 'invalid', reason: 'no tests ran', test: file.test };
    ran.push(file.test);
  }
  return { outcome: 'survived', ran };
}

function timeoutSecondsFor(file: BaselineFile): number {
  return (file.durationMs * TIMEOUT_FACTOR + TIMEOUT_SLACK_MS) / 1000;
}
