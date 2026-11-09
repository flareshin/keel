import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { diffEntries } from '../evidence/gitcmd.ts';
import { baselineTimeoutSeconds, materializeTree, runBaseline } from './baseline.ts';
import { bindPrecheck, precheckTreeOf } from './binding.ts';
import { changedScripts, currentHostLoad, describeMutant, mutantTargets, settledVerdicts } from './census.ts';
import type { CensusMutant, CensusResult, CensusTarget } from './census.ts';
import { addedLinesByPath } from './consumers.ts';
import { COLUMN_GAP, mutantLine, OPEN_SECTIONS, renderStoppedBaseline, RERUN_LINE_START } from './render.ts';
import { runMutants } from './run.ts';
import type { MutantTarget } from './run.ts';
import { isRunnableTest } from './select.ts';

export interface SurvivorRerun {
  tree: string;
  tests: string[];
  baselineNotRun: string[];
  results: CensusResult[];
  notRun: CensusMutant[];
}

export class RerunRefused extends Error {}

const INDENTED = /^\s/u;
const BLOBS_LINE = /^blobs\s+(.*)$/mu;
const BLOB_SEPARATOR = ' · ';
const RUN_FULL_PRECHECK = 'run keel precheck run';

export function censusBeforeRerun(output: string): string {
  const start = output.search(new RegExp(`^${RERUN_LINE_START}`, 'mu'));
  return (start < 0 ? output : output.slice(0, start)).trimEnd();
}

export function openMutantLines(census: string): string[] {
  const lines = census.split('\n');
  return lines.flatMap((line, index) => (OPEN_SECTIONS.includes(line) ? linesOfSection(lines, index + 1) : []));
}

function linesOfSection(lines: string[], start: number): string[] {
  const end = lines.findIndex((line, index) => index >= start && !INDENTED.test(line));
  return lines.slice(start, end < 0 ? lines.length : end);
}

export async function rerunSurvivors(repo: string, target: CensusTarget, census: string, baselineBudgetMs?: number): Promise<SurvivorRerun> {
  const precheckTree = precheckTreeOf(census);
  if (precheckTree === null) throw new RerunRefused(`the first line is not "precheck tree <40-hex tree id>"; ${RUN_FULL_PRECHECK}`);
  const open = openMutantLines(census);
  if (open.length === 0) throw new RerunRefused('the census lists no survived or no-test-reaches mutant, so there is nothing to rerun');
  const blobs = boundBlobs(repo, target, census, precheckTree);
  const tests = testsChangedSince(repo, precheckTree, target.tree);
  if (tests.length === 0) throw new RerunRefused(`no runnable test changed since tree ${precheckTree}; ${RUN_FULL_PRECHECK}`);
  const directory = materializeTree(repo, target.tree);
  try {
    const host = currentHostLoad();
    const baseline = await runBaseline(directory, tests, baselineTimeoutSeconds(host.load, host.cpus), undefined, baselineBudgetMs);
    if (baseline.outcome !== 'green') throw new RerunRefused(renderStoppedBaseline(baseline));
    const { sources, reruns } = rerunTargets(repo, target, directory, blobs, open);
    const run = await runMutants(directory, baseline.files, reruns);
    const describe = (each: MutantTarget): CensusMutant => describeMutant(sources.get(each.path) ?? '', each);
    return {
      tree: target.tree,
      tests: tests.filter((test) => !baseline.notRun.includes(test)),
      baselineNotRun: baseline.notRun,
      ...settledVerdicts(run, baseline.notRun, describe),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function boundBlobs(repo: string, target: CensusTarget, census: string, precheckTree: string): Record<string, string> {
  const binding = bindPrecheck(repo, target.reviewBase, target.tree, precheckTree);
  if (binding.test_change === null) throw new RerunRefused(`tree ${precheckTree} is not in ${repo}; ${RUN_FULL_PRECHECK}`);
  if (binding.test_change.lines_removed) throw new RerunRefused(`existing test lines changed or were removed after the precheck; ${RUN_FULL_PRECHECK}`);
  const recorded = recordedBlobs(census);
  const changed = [...new Set([...Object.keys(binding.blobs), ...recorded.keys()])].find((path) => binding.blobs[path] !== recorded.get(path));
  if (changed !== undefined) throw new RerunRefused(`${changed} differs from the census blobs; ${RUN_FULL_PRECHECK}`);
  return binding.blobs;
}

function recordedBlobs(census: string): Map<string, string> {
  const entries = (BLOBS_LINE.exec(census)?.[1] ?? '').trim().split(BLOB_SEPARATOR);
  return new Map(entries.filter((entry) => entry.includes(' ')).map((entry) => {
    const space = entry.lastIndexOf(' ');
    return [entry.slice(0, space), entry.slice(space + 1)];
  }));
}

function testsChangedSince(repo: string, precheckTree: string, tree: string): string[] {
  return diffEntries(repo, precheckTree, tree).map((entry) => entry.path).filter(isRunnableTest);
}

function rerunTargets(repo: string, target: CensusTarget, directory: string, blobs: Record<string, string>, open: string[]): { sources: Map<string, string>; reruns: MutantTarget[] } {
  const paths = changedScripts(repo, target.reviewBase, target.tree, blobs);
  const sources = new Map(paths.map((path) => [path, readFileSync(join(directory, path), 'utf8')]));
  const targets = mutantTargets(sources, addedLinesByPath(repo, target.reviewBase, target.tree));
  const lines = new Map(targets.map((each) => [each, mutantLine(describeMutant(sources.get(each.path) ?? '', each))]));
  const unmatched = open.find((line) => !targets.some((each) => isLineOf(line, lines.get(each)!)));
  if (unmatched !== undefined) throw new RerunRefused(`no mutant matches "${unmatched.trim()}"; ${RUN_FULL_PRECHECK}`);
  return { sources, reruns: targets.filter((each) => open.some((line) => isLineOf(line, lines.get(each)!))) };
}

function isLineOf(line: string, mutant: string): boolean {
  return line === mutant || line.startsWith(mutant + COLUMN_GAP);
}
