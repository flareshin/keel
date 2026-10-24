import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Coverage {
  seen: Set<string>;
  executedLines: Map<string, Set<number>>;
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

export class CoverageFormatError extends Error {}

const COVERAGE_FILE = /^coverage-.*\.json$/u;
const FILE_URL_PREFIX = 'file://';
const NOT_WHITESPACE = /\S/u;

export function readCoverage(coverageDir: string, repoRoot: string): Coverage {
  const root = realpathSync(repoRoot);
  const coverage: Coverage = { seen: new Set(), executedLines: new Map() };
  for (const name of readdirSync(coverageDir).filter((entry) => COVERAGE_FILE.test(entry)).sort()) {
    for (const script of parseCoverageFile(join(coverageDir, name))) {
      const path = repoRelativePath(script.url, root);
      if (path === null) continue;
      coverage.seen.add(path);
      const lines = coverage.executedLines.get(path) ?? new Set<number>();
      for (const line of executedLines(readFileSync(join(root, path), 'utf8'), script.ranges)) lines.add(line);
      coverage.executedLines.set(path, lines);
    }
  }
  return coverage;
}

function parseCoverageFile(file: string): ScriptCoverage[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const scripts = isRecord(parsed) ? parsed['result'] : undefined;
  if (!Array.isArray(scripts) || !scripts.every(isScriptCoverage)) {
    throw new CoverageFormatError(`${file} is not V8 coverage output`);
  }
  return scripts.map((script) => ({ url: script.url, ranges: script.functions.flatMap((fn) => fn.ranges) }));
}

function repoRelativePath(url: string, root: string): string | null {
  if (!url.startsWith(FILE_URL_PREFIX)) return null;
  const path = relative(root, fileURLToPath(url));
  if (path === '' || path.startsWith('..') || path.startsWith(sep)) return null;
  return path.split(sep).join('/');
}

function executedLines(source: string, ranges: Range[]): Set<number> {
  const counts = new Array<number>(source.length).fill(0);
  const outerFirst = [...ranges].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const range of outerFirst) counts.fill(range.count, range.startOffset, Math.min(range.endOffset, source.length));
  const lines = new Set<number>();
  let line = 1;
  for (let offset = 0; offset < source.length; offset++) {
    const char = source[offset] as string;
    if (char === '\n') line++;
    else if ((counts[offset] as number) > 0 && NOT_WHITESPACE.test(char)) lines.add(line);
  }
  return lines;
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
