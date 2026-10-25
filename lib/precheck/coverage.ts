import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Coverage {
  seen: Set<string>;
  executedSpans: Map<string, Span[]>;
}

export interface Span {
  start: number;
  end: number;
}

interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

interface ScriptCoverage {
  url: string;
  ranges: Range[];
}

interface ScriptLocation {
  path: string;
  prefix: number;
}

export class CoverageFormatError extends Error {}

const COVERAGE_FILE = /^coverage-.*\.json$/u;
const FILE_URL_PREFIX = 'file://';
const SOURCE_PREFIX_PARAM = 'keel-prefix';
const DECIMAL_DIGITS = /^[0-9]+$/u;

export function readCoverage(coverageDir: string, repoRoot: string): Coverage {
  const root = realpathSync(repoRoot);
  const coverage: Coverage = { seen: new Set(), executedSpans: new Map() };
  for (const name of readdirSync(coverageDir).filter((entry) => COVERAGE_FILE.test(entry)).sort()) {
    for (const script of parseCoverageFile(join(coverageDir, name))) {
      const location = scriptLocation(script.url, root);
      if (location === null || !existsSync(join(root, location.path))) continue;
      const { path, prefix } = location;
      coverage.seen.add(path);
      const ranges = script.ranges.map((range) => shiftRange(range, prefix));
      const spans = executedSpans(readFileSync(join(root, path), 'utf8'), ranges);
      coverage.executedSpans.set(path, [...coverage.executedSpans.get(path) ?? [], ...spans]);
    }
  }
  return coverage;
}

function parseCoverageFile(file: string): ScriptCoverage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CoverageFormatError(`${file} is not V8 coverage output`, { cause: error });
  }
  const scripts = isRecord(parsed) ? parsed['result'] : undefined;
  if (!Array.isArray(scripts) || !scripts.every(isScriptCoverage)) {
    throw new CoverageFormatError(`${file} is not V8 coverage output`);
  }
  return scripts.map((script) => ({ url: script.url, ranges: script.functions.flatMap((fn) => fn.ranges) }));
}

function scriptLocation(url: string, root: string): ScriptLocation | null {
  if (!url.startsWith(FILE_URL_PREFIX)) return null;
  const parsed = new URL(url);
  const path = relative(root, fileURLToPath(parsed));
  if (path === '' || path.startsWith('..') || path.startsWith(sep)) return null;
  const prefix = new URLSearchParams(parsed.hash.slice(1)).get(SOURCE_PREFIX_PARAM);
  if (prefix !== null && !DECIMAL_DIGITS.test(prefix)) return null;
  return { path: path.split(sep).join('/'), prefix: prefix === null ? 0 : Number(prefix) };
}

function shiftRange(range: Range, prefix: number): Range {
  return { ...range, startOffset: Math.max(0, range.startOffset - prefix), endOffset: Math.max(0, range.endOffset - prefix) };
}

function executedSpans(source: string, ranges: Range[]): Span[] {
  const counts = new Array<number>(source.length).fill(0);
  const outerFirst = [...ranges].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const range of outerFirst) counts.fill(range.count, range.startOffset, Math.min(range.endOffset, source.length));
  const spans: Span[] = [];
  let open: Span | null = null;
  for (let offset = 0; offset < source.length; offset++) {
    if ((counts[offset] as number) === 0) open = null;
    else if (open === null) spans.push(open = { start: offset, end: offset + 1 });
    else open.end = offset + 1;
  }
  return spans;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScriptCoverage(value: unknown): value is { url: string; functions: Array<{ ranges: Range[] }> } {
  return isRecord(value) && typeof value['url'] === 'string' && Array.isArray(value['functions'])
    && value['functions'].every((fn) => isRecord(fn) && Array.isArray(fn['ranges']) && fn['ranges'].every(isRange));
}

function isRange(value: unknown): value is Range {
  return isRecord(value) && Number.isInteger(value['startOffset']) && Number.isInteger(value['endOffset'])
    && Number.isInteger(value['count']);
}
