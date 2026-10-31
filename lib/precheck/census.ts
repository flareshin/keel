import { readFileSync, rmSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { diffEntries, REGULAR_FILE_MODES } from '../evidence/gitcmd.ts';
import { baselineTimeoutSeconds, materializeTree, runBaseline } from './baseline.ts';
import type { Baseline } from './baseline.ts';
import { bindPrecheck, DELETED_BLOB } from './binding.ts';
import { addedLinesByPath, findConsumers, SCRIPT_FILE } from './consumers.ts';
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

export interface HostLoad {
  load: number;
  cpus: number;
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
  | { outcome: 'ran'; timeoutSeconds: number; baselineFiles: number; baselinePasses: number; withoutPasses: number; results: CensusResult[]; notRun: CensusMutant[]; elapsedMs: number };

export interface Census {
  tree: string;
  base: string;
  paths: { source: number; test: number };
  blobs: Record<string, string>;
  mutation: MutationCensus;
  consumers: ChangedName[];
}

const HOOK_DIRECTORY = 'hooks/';
const HOOK_DIFF_MAX_PRIORITY = 3;
const SNIPPET_LIMIT = 40;
const ELLIPSIS = '…';
const MASKED_TEXT = `'${ELLIPSIS}'`;
const MASKED_PATTERN = `/${ELLIPSIS}/`;
const REMOVALS = new Set(['', ';']);
const MASKED_KINDS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.StringLiteral, MASKED_TEXT],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, MASKED_TEXT],
  [ts.SyntaxKind.TemplateHead, MASKED_TEXT],
  [ts.SyntaxKind.TemplateMiddle, MASKED_TEXT],
  [ts.SyntaxKind.TemplateTail, MASKED_TEXT],
  [ts.SyntaxKind.RegularExpressionLiteral, MASKED_PATTERN],
]);
const TRIVIA_TOKENS = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

export async function runCensus(repo: string, target: CensusTarget, host: HostLoad = currentHostLoad()): Promise<Census> {
  const blobs = bindPrecheck(repo, target.reviewBase, target.tree, target.tree).blobs;
  const entries = diffEntries(repo, target.reviewBase, target.tree);
  const regularFiles = new Set(entries.filter((entry) => REGULAR_FILE_MODES.includes(entry.mode)).map((entry) => entry.path));
  const sourcePaths = Object.keys(blobs);
  const scriptFiles = sourcePaths.filter((path) => regularFiles.has(path) && SCRIPT_FILE.test(path));
  return {
    tree: target.tree,
    base: target.base,
    paths: { source: sourcePaths.length, test: entries.length - sourcePaths.length },
    blobs,
    mutation: await runMutation(repo, target, sourcePaths.filter((path) => blobs[path] !== DELETED_BLOB), scriptFiles, baselineTimeoutSeconds(host.load, host.cpus)),
    consumers: findConsumers(repo, target.reviewBase, target.tree),
  };
}

function currentHostLoad(): HostLoad {
  return { load: loadavg()[0]!, cpus: availableParallelism() };
}

async function runMutation(repo: string, target: CensusTarget, sourcePaths: string[], scriptFiles: string[], timeoutSeconds: number): Promise<MutationCensus> {
  const directory = materializeTree(repo, target.tree);
  try {
    const baseline = await runBaseline(directory, candidateTests(directory, sourcePaths), timeoutSeconds);
    if (baseline.outcome !== 'green') return { outcome: 'stopped', baseline };
    const sources = new Map(scriptFiles.map((path) => [path, readFileSync(join(directory, path), 'utf8')]));
    const targets = mutantTargets(sources, addedLinesByPath(repo, target.reviewBase, target.tree));
    const hookDiff = sourcePaths.some((path) => path.startsWith(HOOK_DIRECTORY));
    const runnable = hookDiff ? targets.filter((each) => each.mutant.priority <= HOOK_DIFF_MAX_PRIORITY) : targets;
    const started = performance.now();
    const run = await runMutants(directory, baseline.files, runnable);
    const describe = (each: MutantTarget): CensusMutant => describeMutant(sources.get(each.path) ?? '', each);
    return {
      outcome: 'ran',
      timeoutSeconds: baseline.timeoutSeconds,
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
  const masks = maskedSpans(code);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  let snippet = '';
  let spaced = false;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (TRIVIA_TOKENS.has(kind)) {
      spaced = snippet !== '';
      continue;
    }
    const mask = masks.find((span) => span.start <= scanner.getTokenStart() && scanner.getTokenStart() < span.end);
    snippet += (spaced ? ' ' : '') + (mask?.text ?? scanner.getTokenText());
    spaced = false;
    if (mask !== undefined) scanner.resetTokenState(mask.end);
  }
  return snippet.length > SNIPPET_LIMIT ? snippet.slice(0, SNIPPET_LIMIT - ELLIPSIS.length) + ELLIPSIS : snippet;
}

function maskedSpans(code: string): { start: number; end: number; text: string }[] {
  const file = ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.Latest);
  const spans: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    const text = MASKED_KINDS.get(node.kind);
    if (text === undefined) ts.forEachChild(node, visit);
    else spans.push({ start: node.getStart(file), end: node.end, text });
  };
  visit(file);
  return spans;
}
