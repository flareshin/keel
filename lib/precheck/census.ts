import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { diffEntries } from '../evidence/gitcmd.ts';
import { materializeTree, runBaseline } from './baseline.ts';
import type { Baseline } from './baseline.ts';
import { bindPrecheck, DELETED_BLOB } from './binding.ts';
import { addedLinesByPath, findConsumers } from './consumers.ts';
import type { ChangedName } from './consumers.ts';
import { generateMutants } from './mutants.ts';
import type { Operator } from './mutants.ts';
import { runMutants } from './run.ts';
import type { MutantTarget, MutantVerdict } from './run.ts';
import { candidateTests } from './select.ts';

export interface CensusTarget {
  base: string;
  reviewBase: string;
  tree: string;
}

export interface CensusMutant {
  path: string;
  line: number;
  operator: Operator;
  change: string;
}

export interface CensusResult extends CensusMutant {
  coverage: 'known' | 'unknown';
  verdict: MutantVerdict;
}

export type MutationCensus =
  | { outcome: 'stopped'; baseline: Exclude<Baseline, { outcome: 'green' }> }
  | { outcome: 'ran'; baselineFiles: number; baselinePasses: number; withoutPasses: number; results: CensusResult[]; notRun: CensusMutant[]; elapsedMs: number };

export interface Census {
  tree: string;
  base: string;
  paths: { source: number; test: number };
  blobs: Record<string, string>;
  mutation: MutationCensus;
  consumers: ChangedName[];
}

const BASELINE_TIMEOUT_SECONDS = 300;
const HOOK_DIRECTORY = 'hooks/';
const HOOK_DIFF_MAX_PRIORITY = 3;
const SNIPPET_LIMIT = 40;
const ELLIPSIS = '…';
const MASKED_TEXT = `'${ELLIPSIS}'`;
const REMOVALS = new Set(['', ';']);
const TEXT_TOKENS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);
const TRIVIA_TOKENS = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

export async function runCensus(repo: string, target: CensusTarget): Promise<Census> {
  const blobs = bindPrecheck(repo, target.reviewBase, target.tree, target.tree).blobs;
  const changedCount = diffEntries(repo, target.reviewBase, target.tree).length;
  const sourcePaths = Object.keys(blobs);
  return {
    tree: target.tree,
    base: target.base,
    paths: { source: sourcePaths.length, test: changedCount - sourcePaths.length },
    blobs,
    mutation: await runMutation(repo, target, sourcePaths.filter((path) => blobs[path] !== DELETED_BLOB)),
    consumers: findConsumers(repo, target.reviewBase, target.tree),
  };
}

async function runMutation(repo: string, target: CensusTarget, sourcePaths: string[]): Promise<MutationCensus> {
  const directory = materializeTree(repo, target.tree);
  try {
    const baseline = await runBaseline(directory, candidateTests(directory, sourcePaths), BASELINE_TIMEOUT_SECONDS);
    if (baseline.outcome !== 'green') return { outcome: 'stopped', baseline };
    const sources = new Map(sourcePaths.map((path) => [path, readFileSync(join(directory, path), 'utf8')]));
    const targets = mutantTargets(sources, addedLinesByPath(repo, target.reviewBase, target.tree));
    const hookDiff = sourcePaths.some((path) => path.startsWith(HOOK_DIRECTORY));
    const runnable = hookDiff ? targets.filter((each) => each.mutant.priority <= HOOK_DIFF_MAX_PRIORITY) : targets;
    const started = performance.now();
    const run = await runMutants(directory, baseline.files, runnable);
    const describe = (each: MutantTarget): CensusMutant => describeMutant(sources.get(each.path) ?? '', each);
    return {
      outcome: 'ran',
      baselineFiles: baseline.files.length,
      baselinePasses: baseline.files.reduce((sum, file) => sum + file.passed, 0),
      withoutPasses: baseline.withoutPasses.length,
      results: run.results.map((result) => ({ ...describe(result), coverage: result.coverage, verdict: result.verdict })),
      notRun: [...run.notRun, ...targets.filter((each) => !runnable.includes(each))].map(describe),
      elapsedMs: performance.now() - started,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function mutantTargets(sources: Map<string, string>, addedLines: Map<string, Set<number>>): MutantTarget[] {
  return [...sources]
    .flatMap(([path, source]) => generateMutants(path, source, addedLines.get(path) ?? new Set()).map((mutant) => ({ path, mutant })))
    .sort((a, b) => a.mutant.priority - b.mutant.priority);
}

function describeMutant(source: string, { path, mutant }: MutantTarget): CensusMutant {
  return { path, line: mutant.line, operator: mutant.operator, change: changeText(source.slice(mutant.start, mutant.end), mutant.operator, mutant.replacement) };
}

function changeText(original: string, operator: Operator, replacement: string): string {
  if (operator === 'text-removal') return 'text removed';
  if (REMOVALS.has(replacement)) return `${codeSnippet(original)} removed`;
  return `${codeSnippet(original)} → ${codeSnippet(replacement)}`;
}

function codeSnippet(code: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  const templateBraces: number[] = [];
  let braces = 0;
  let snippet = '';
  let spaced = false;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && templateBraces.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) templateBraces.pop();
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      braces++;
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      braces--;
    }
    if (kind === ts.SyntaxKind.TemplateHead) templateBraces.push(braces);
    if (TRIVIA_TOKENS.has(kind)) {
      spaced = snippet !== '';
      continue;
    }
    snippet += (spaced ? ' ' : '') + (TEXT_TOKENS.has(kind) ? MASKED_TEXT : scanner.getTokenText());
    spaced = false;
  }
  return snippet.length > SNIPPET_LIMIT ? snippet.slice(0, SNIPPET_LIMIT - ELLIPSIS.length) + ELLIPSIS : snippet;
}
