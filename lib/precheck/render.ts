import type { Census, CensusMutant, CensusResult, MutationCensus } from './census.ts';
import type { ChangedName } from './consumers.ts';

type Ran = Extract<MutationCensus, { outcome: 'ran' }>;
type Stopped = Extract<MutationCensus, { outcome: 'stopped' }>;

const LABEL_WIDTH = 10;
const SEPARATOR = ' · ';
const NO_BLOBS = 'none';
const INDENT = '  ';
const COLUMN_GAP = '  ';
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const VERDICT_ORDER = ['killed', 'survived', 'no test reaches', 'invalid', 'timeout'] as const;

export function renderCensus(census: Census): string {
  const mutation = census.mutation;
  const body = mutation.outcome === 'ran' ? ranLines(census.blobs, mutation) : [labelled('baseline', stoppedReason(mutation))];
  return [headerLine(census), ...body, ...consumerLines(census.consumers)].join('\n');
}

export function summarizeCensus(census: Census): Record<string, unknown> {
  const mutation = census.mutation;
  const summary = { tree: census.tree, base: census.base, paths: census.paths };
  if (mutation.outcome === 'stopped') return { ...summary, outcome: 'stopped', baseline: mutation.baseline.outcome };
  return { ...summary, outcome: scopeOf(mutation), mutants: { candidates: candidateCount(mutation), ...verdictCounts(mutation.results), not_run: mutation.notRun.length }, elapsed_ms: Math.round(mutation.elapsedMs) };
}

function headerLine(census: Census): string {
  const { source, test } = census.paths;
  const scope = census.mutation.outcome === 'stopped' ? 'precheck stopped at baseline' : scopeText(census.mutation);
  return [`precheck tree ${census.tree}`, `base ${census.base}`, `${source + test} paths (${source} source, ${test} test)`, scope].join(SEPARATOR);
}

function scopeText(mutation: Ran): string {
  if (scopeOf(mutation) === 'census') return 'census (all candidates ran)';
  return `partial check: ${mutation.results.length} of ${candidateCount(mutation)} candidates ran`;
}

function scopeOf(mutation: Ran): 'census' | 'partial' {
  return mutation.notRun.length === 0 ? 'census' : 'partial';
}

function stoppedReason({ baseline }: Stopped): string {
  if (baseline.outcome === 'empty') return 'no candidate file ran a test · precheck stopped';
  return `${baseline.outcome} in ${baseline.test} · precheck stopped`;
}

function ranLines(blobs: Record<string, string>, mutation: Ran): string[] {
  const entries = Object.entries(blobs).map(([path, blob]) => `${path} ${blob}`);
  const counts = verdictCounts(mutation.results);
  const withoutPasses = mutation.withoutPasses > 0 ? [`${mutation.withoutPasses} without passes`] : [];
  const notRun = mutation.notRun.length > 0 ? [`not run ${mutation.notRun.length}`] : [];
  return [
    labelled('blobs', entries.length > 0 ? entries.join(SEPARATOR) : NO_BLOBS),
    labelled('baseline', [`${mutation.baselineFiles} test files`, `${mutation.baselinePasses} pass`, 'coverage collected', ...withoutPasses].join(SEPARATOR)),
    labelled('mutants', [`candidates ${candidateCount(mutation)}`, ...VERDICT_ORDER.map((verdict) => `${verdict} ${counts[verdict]}`), ...notRun, duration(mutation.elapsedMs)].join(SEPARATOR)),
    ...section('survived', mutation.results.filter((result) => result.verdict.outcome === 'survived').map(survivedLine)),
    ...section('no test reaches', mutation.results.filter((result) => result.verdict.outcome === 'no test reaches').map(mutantLine)),
    ...section('not run', mutation.notRun.map(mutantLine)),
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
  const coverage = result.coverage === 'unknown' ? [COLUMN_GAP + 'coverage unknown'] : [];
  return [mutantLine(result), `${COLUMN_GAP}ran: ${ran.join(', ')}`, ...coverage].join('');
}

function mutantLine(mutant: CensusMutant): string {
  return INDENT + [`${mutant.path}:${mutant.line}`, mutant.operator, mutant.change].join(COLUMN_GAP);
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
