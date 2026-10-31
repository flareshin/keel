import * as gitcmd from '../evidence/gitcmd.ts';
import { globMatches } from '../evidence/glob.ts';
import { candidateTests, isTestSupport } from './select.ts';

const SHIP_GATE_PARITY_SHARDS = 8;
export const CORPUS_TESTS = [
  ...Array.from({ length: SHIP_GATE_PARITY_SHARDS }, (_unused, index) => `tests/ship-gate/ship-gate-parity-shard-${index + 1}.test.ts`),
  'tests/hooks/hook-parity.test.ts',
  'codex/tests/hook-parity.test.ts',
  'codex/tests/cli-parity.test.ts',
];
export const FULL_SUITE_PATTERNS = [
  'hooks/**', 'lib/**', 'measure/lib/**', 'measure/boundary*', 'codex/hooks/**',
  'codex/lib/**', 'skills/readable-code/scripts/**', 'githooks/**', 'settings/core.json',
];

export function affectedTests(root: string, changedPaths: string[]): string[] {
  const reachedFromTests = new Set(candidateTests(root, changedPaths.filter(isTestSupport)));
  return candidateTests(root, changedPaths).filter((test) => !CORPUS_TESTS.includes(test) || reachedFromTests.has(test));
}

export function changedSince(root: string, mergeBase: string): string[] {
  const tracked = gitcmd.text(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase]);
  const untracked = gitcmd.text(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))].sort();
}

export function fullSuitePaths(paths: string[]): string[] {
  return paths.filter((path) => FULL_SUITE_PATTERNS.some((pattern) => globMatches(path, pattern)));
}
