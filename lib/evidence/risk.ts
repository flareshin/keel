import { fnmatchCase } from './pycompat.ts';
import { isGitlink } from './gitcmd.ts';
import type { PathEntry, PathStat } from './gitcmd.ts';
import type { RiskRule } from './registry.ts';

export const SMOKE_ONLY = 'smoke-only';
export const LIGHT = 'light';
export const STANDARD = 'standard';
export const HEAVY = 'heavy';
export const CLASS_ORDER = [SMOKE_ONLY, LIGHT, STANDARD, HEAVY];
const LOGIC_CLASSES = [STANDARD, HEAVY];
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__']);
const TEST_BASENAME_GLOBS = ['test_*.py', '*_test.*', '*.test.*', '*.spec.*'];

export interface PathRisk {
  path: string;
  riskClass: string;
  why: string;
  isTest: boolean;
  isGitlink: boolean;
}

export interface Risk {
  riskClass: string;
  paths: PathRisk[];
  files: number;
  lines: number;
}

export function logicPaths(risk: Risk): string[] {
  return risk.paths
    .filter((item) => !item.isTest && !item.isGitlink && LOGIC_CLASSES.includes(item.riskClass))
    .map((item) => item.path);
}

export function hasTestPath(risk: Risk): boolean {
  return risk.paths.some((item) => item.isTest);
}

export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))) return true;
  const basename = segments.at(-1)!;
  return TEST_BASENAME_GLOBS.some((glob) => fnmatchCase(basename, glob));
}

export function classifyPath(entry: PathEntry, rules: RiskRule[]): PathRisk {
  if (isTestPath(entry.path)) return { path: entry.path, riskClass: LIGHT, why: 'test', isTest: true, isGitlink: isGitlink(entry) };
  const matching = rules.filter((rule) => fnmatchCase(entry.path, rule.pathGlob));
  if (matching.length === 0) return { path: entry.path, riskClass: STANDARD, why: 'no rule', isTest: false, isGitlink: isGitlink(entry) };
  const heaviest = matching.reduce((best, rule) =>
    CLASS_ORDER.indexOf(rule.riskClass) > CLASS_ORDER.indexOf(best.riskClass) ? rule : best);
  return { path: entry.path, riskClass: heaviest.riskClass, why: 'rule ' + heaviest.pathGlob, isTest: false, isGitlink: isGitlink(entry) };
}

export function classify(entries: PathEntry[], stats: Map<string, PathStat>, rules: RiskRule[]): Risk {
  const paths = entries.map((entry) => classifyPath(entry, rules));
  const lines = [...stats.values()].reduce((sum, stat) => sum + stat.added + stat.deleted, 0);
  return { riskClass: pushClass(paths), paths, files: entries.length, lines };
}

function pushClass(paths: PathRisk[]): string {
  if (paths.length === 0) return STANDARD;
  if (paths.every((item) => item.riskClass === SMOKE_ONLY)) return SMOKE_ONLY;
  const lightRank = CLASS_ORDER.indexOf(LIGHT);
  const ranks = paths.map((item) => Math.max(CLASS_ORDER.indexOf(item.riskClass), lightRank));
  return CLASS_ORDER[Math.max(...ranks)]!;
}
