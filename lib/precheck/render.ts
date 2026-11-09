import type { Census, CensusMutant, CensusResult, MutationCensus } from './census.ts';
import type { ChangedName } from './consumers.ts';
import type { SurvivorRerun } from './rerun.ts';

type Ran = Extract<MutationCensus, { outcome: 'ran' }>;
type Stopped = Extract<MutationCensus, { outcome: 'stopped' }>;

const LABEL_WIDTH = 10;
const SEPARATOR = ' · ';
const NO_BLOBS = 'none';
const INDENT = '  ';
export const COLUMN_GAP = '  ';
const STOPPED_OUTPUT_LINES = 20;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const VERDICT_ORDER = ['killed', 'survived', 'no test reaches', 'invalid', 'timeout'] as const;
const SURVIVED_SECTION = 'survived';
const UNREACHED_SECTION = 'no test reaches';
export const OPEN_SECTIONS = [SURVIVED_SECTION, UNREACHED_SECTION];
export const RERUN_LINE_START = 'rerun: survivors';

export function renderCensus(census: Census): string {
  const mutation = census.mutation;
  const body = mutation.outcome === 'ran' ? ranLines(census.blobs, mutation) : [labelled('baseline', stoppedReason(mutation)), ...stoppedOutputLines(mutation)];
  return [headerLine(census), ...body, ...consumerLines(census.consumers)].join('\n');
}

export function summarizeCensus(census: Census): Record<string, unknown> {
  const mutation = census.mutation;
  const summary = { tree: census.tree, base: census.base, paths: census.paths };
  if (mutation.outcome === 'stopped') return { ...summary, outcome: 'stopped', baseline: mutation.baseline.outcome, ...('test' in mutation.baseline ? { baseline_test: mutation.baseline.test } : {}), ...('notRun' in mutation.baseline ? { baseline_not_run: mutation.baseline.notRun.length } : {}) };
  return { ...summary, outcome: scopeOf(mutation), mutants: { candidates: candidateCount(mutation), ...verdictCounts(mutation.results), not_run: mutation.notRun.length }, baseline_not_run: mutation.baselineNotRun.length, elapsed_ms: Math.round(mutation.elapsedMs) };
}

export function renderStoppedBaseline(baseline: Stopped['baseline']): string {
  return [stoppedReason({ baseline }), ...stoppedOutputLines({ baseline })].join('\n');
}

export function summarizeRerun(rerun: SurvivorRerun, base: string): Record<string, unknown> {
  return { tree: rerun.tree, base, outcome: 'rerun', tests: rerun.tests, mutants: { ...verdictCounts(rerun.results), not_run: rerun.notRun.length }, baseline_not_run: rerun.baselineNotRun };
}

export function renderRerun(rerun: SurvivorRerun): string {
  const counts = verdictCounts(rerun.results);
  const notRun = rerun.notRun.length > 0 ? [`${rerun.notRun.length} not run`] : [];
  const verdicts = VERDICT_ORDER.map((verdict) => `${counts[verdict]} ${verdict}`);
  return [
    [RERUN_LINE_START, ...verdicts, ...notRun, `tree ${rerun.tree}`, `ran ${rerun.tests.join(', ')}`].join(SEPARATOR),
    ...section('still survived', rerun.results.filter((result) => result.verdict.outcome === 'survived').map(survivedLine)),
    ...section('still no test reaches', rerun.results.filter((result) => result.verdict.outcome === 'no test reaches').map(unreachedLine)),
    ...section('invalid', rerun.results.filter((result) => result.verdict.outcome === 'invalid').map(mutantLine)),
    ...section('timeout', rerun.results.filter((result) => result.verdict.outcome === 'timeout').map(timedOutLine)),
    ...section('not run', rerun.notRun.map(mutantLine)),
    ...section('baseline not run', rerun.baselineNotRun.map((test) => INDENT + test)),
  ].join('\n');
}

function headerLine(census: Census): string {
  const { source, test } = census.paths;
  const scope = census.mutation.outcome === 'stopped' ? 'precheck stopped at baseline' : scopeText(census.mutation);
  return [`precheck tree ${census.tree}`, `base ${census.base}`, `${source + test} paths (${source} source, ${test} test)`, scope].join(SEPARATOR);
}

function scopeText(mutation: Ran): string {
  if (scopeOf(mutation) === 'census') return 'census (all candidates ran)';
  const check = `partial check: ${mutation.results.length} of ${candidateCount(mutation)} candidates ran`;
  return mutation.baselineNotRun.length > 0 ? check + SEPARATOR + `baseline budget left ${mutation.baselineNotRun.length} test files not run` : check;
}

function scopeOf(mutation: Ran): 'census' | 'partial' {
  return mutation.notRun.length === 0 && mutation.baselineNotRun.length === 0 ? 'census' : 'partial';
}

function stoppedReason({ baseline }: Pick<Stopped, 'baseline'>): string {
  if (baseline.outcome === 'budget') return `budget spent before any file passed · ${baseline.notRun.length} test files not run · precheck stopped`;
  if (baseline.outcome === 'empty') return 'no candidate file ran a test · precheck stopped';
  if (baseline.outcome === 'timeout') return `timeout after ${baseline.timeoutSeconds}s in ${baseline.test} · precheck stopped`;
  return `red in ${baseline.test} · precheck stopped`;
}

function stoppedOutputLines({ baseline }: Pick<Stopped, 'baseline'>): string[] {
  if (baseline.outcome === 'budget') return section('baseline not run', baseline.notRun.map((test) => INDENT + test));
  if (baseline.outcome === 'empty' || baseline.output === '') return [];
  return baseline.output.trimEnd().split('\n').slice(-STOPPED_OUTPUT_LINES).map((line) => INDENT + line);
}

function ranLines(blobs: Record<string, string>, mutation: Ran): string[] {
  const entries = Object.entries(blobs).map(([path, blob]) => `${path} ${blob}`);
  const counts = verdictCounts(mutation.results);
  const withoutPasses = mutation.withoutPasses > 0 ? [`${mutation.withoutPasses} without passes`] : [];
  const baselineNotRun = mutation.baselineNotRun.length > 0 ? [`not run ${mutation.baselineNotRun.length}`] : [];
  const notRun = mutation.notRun.length > 0 ? [`not run ${mutation.notRun.length}`] : [];
  return [
    labelled('blobs', entries.length > 0 ? entries.join(SEPARATOR) : NO_BLOBS),
    labelled('baseline', [`${mutation.baselineFiles} test files`, `${mutation.baselinePasses} pass`, 'coverage collected', ...withoutPasses, ...baselineNotRun, `timeout ${mutation.timeoutSeconds}s per file`].join(SEPARATOR)),
    labelled('mutants', [`candidates ${candidateCount(mutation)}`, ...VERDICT_ORDER.map((verdict) => `${verdict} ${counts[verdict]}`), ...notRun, duration(mutation.elapsedMs)].join(SEPARATOR)),
    ...section(SURVIVED_SECTION, mutation.results.filter((result) => result.verdict.outcome === 'survived').map(survivedLine)),
    ...section('timeout', mutation.results.filter((result) => result.verdict.outcome === 'timeout').map(timedOutLine)),
    ...section(UNREACHED_SECTION, mutation.results.filter((result) => result.verdict.outcome === 'no test reaches').map(unreachedLine)),
    ...section('not run', mutation.notRun.map(mutantLine)),
    ...section('baseline not run', mutation.baselineNotRun.map((test) => INDENT + test)),
  ];
}

function candidateCount(mutation: Ran): number {
  return mutation.results.length + mutation.notRun.length;
}

function verdictCounts(results: CensusResult[]): Record<(typeof VERDICT_ORDER)[number], number> {
  const counts = Object.fromEntries(VERDICT_ORDER.map((verdict) => [verdict, 0])) as Record<(typeof VERDICT_ORDER)[number], number>;
  for (const result of results) counts[result.verdict.outcome]++;
  return counts;
}

function survivedLine(result: CensusResult): string {
  const ran = result.verdict.outcome === 'survived' ? result.verdict.ran : [];
  return [mutantLine(result), `${COLUMN_GAP}ran: ${ran.join(', ')}`, coverageColumn(result)].join('');
}

function unreachedLine(result: CensusResult): string {
  return mutantLine(result) + coverageColumn(result);
}

function coverageColumn(result: CensusResult): string {
  return result.coverage === 'unknown' ? COLUMN_GAP + 'coverage unknown' : '';
}

function timedOutLine(result: CensusResult): string {
  const test = result.verdict.outcome === 'timeout' ? result.verdict.test : '';
  return `${mutantLine(result)}${COLUMN_GAP}test: ${test}`;
}

export function mutantLine(mutant: CensusMutant): string {
  return INDENT + [`${mutant.path}:${mutant.line}:${mutant.column}`, mutant.operator, mutant.change].join(COLUMN_GAP);
}

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? [title, ...lines] : [];
}

function consumerLines(names: ChangedName[]): string[] {
  const consumed = names.filter((name) => name.consumers.length > 0);
  const total = consumed.reduce((sum, name) => sum + name.consumers.length, 0);
  return [
    labelled('consumers', `${names.length} changed names${SEPARATOR}${total} consumers outside the diff`),
    ...consumed.map((name) => INDENT + name.name + COLUMN_GAP + name.consumers.map((consumer) => `${consumer.path}:${consumer.line}`).join(', ')),
  ];
}

function labelled(label: string, text: string): string {
  return label.padEnd(LABEL_WIDTH) + text;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return minutes > 0 ? `${minutes}m${seconds % SECONDS_PER_MINUTE}s` : `${seconds}s`;
}
