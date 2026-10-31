import { diffEntries, diffStats, objectType, text } from '../evidence/gitcmd.ts';
import type { PathEntry, PathStat } from '../evidence/gitcmd.ts';
import { isTestPath } from '../evidence/risk.ts';
import { SCRIPT_FILE } from './consumers.ts';
import { isRunnableTest } from './select.ts';

export const DELETED_BLOB = '0'.repeat(40);
const PRECHECK_HEADER = /^precheck tree ([0-9a-f]{40})(?: ·|$)/u;
export const REQUIRED_SCRIPT_SOURCES = 3;

export interface PrecheckBinding {
  blobs: Record<string, string>;
  test_change: { lines_removed: boolean, lines_added: boolean } | null;
}

export interface PrecheckRequirement {
  required: boolean;
  sources: number;
}

export function precheckTreeOf(precheck: string): string | null {
  return PRECHECK_HEADER.exec(precheck.split('\n')[0]!)?.[1] ?? null;
}

export function bindPrecheck(repo: string, base: string, end: string, precheckTree: string): PrecheckBinding {
  return {
    blobs: nonTestBlobs(repo, base, end),
    test_change: objectType(repo, precheckTree) === 'tree' ? describeTestChange(repo, precheckTree, end) : null,
  };
}

export function precheckRequirement(repo: string, base: string, end: string): PrecheckRequirement {
  const sources = Object.entries(nonTestBlobs(repo, base, end)).filter(([path, blob]) => isPrecheckSource(path, blob)).length;
  return { required: sources >= REQUIRED_SCRIPT_SOURCES && hasRunnableTest(repo, end), sources };
}

export function isPrecheckSource(path: string, blob: string): boolean {
  return blob !== DELETED_BLOB && SCRIPT_FILE.test(path) && !isTestPath(path);
}

function hasRunnableTest(repo: string, end: string): boolean {
  return text(repo, ['ls-tree', '-r', '--name-only', end]).split('\n').some(isRunnableTest);
}

function nonTestBlobs(repo: string, base: string, end: string): Record<string, string> {
  const changed = diffEntries(repo, base, end).filter((entry) => !isTestPath(entry.path));
  return Object.fromEntries(changed.map((entry) => [entry.path, entry.blob ?? DELETED_BLOB]));
}

function describeTestChange(repo: string, precheckTree: string, end: string): PrecheckBinding['test_change'] {
  const stats = diffStats(repo, precheckTree, end);
  const changedTests = diffEntries(repo, precheckTree, end).filter((entry) => isTestPath(entry.path));
  return {
    lines_removed: changedTests.some((entry) => rewritesExistingTest(entry, stats.get(entry.path))),
    lines_added: changedTests.some((entry) => entry.oldBlob === null || (stats.get(entry.path)?.added ?? 0) > 0),
  };
}

function rewritesExistingTest(entry: PathEntry, stat: PathStat | undefined): boolean {
  const isNewOrModeOnly = entry.oldBlob === null || entry.oldBlob === entry.blob;
  if (isNewOrModeOnly) return false;
  const isBinary = stat === undefined || (stat.added === 0 && stat.deleted === 0);
  return isBinary || stat.deleted > 0;
}
