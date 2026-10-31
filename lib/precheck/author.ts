import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type Typecheck = { ok: true } | { ok: false; head: string };

const KEEL_ROOT = join(import.meta.dirname, '..', '..');
const RULE_CHECKS = join(KEEL_ROOT, 'skills', 'readable-code', 'scripts', 'rule-checks.ts');
const TSC_HEAD_LINES = 20;

export function typecheck(repo: string): Typecheck {
  if (!existsSync(join(repo, 'tsconfig.json'))) return { ok: true };
  const completed = spawnSync(tscPath(repo), ['--noEmit', '-p', repo], { cwd: repo, encoding: 'utf8' });
  if (completed.error) throw completed.error;
  if (completed.status === 0) return { ok: true };
  return { ok: false, head: `${completed.stdout}${completed.stderr}`.trimEnd().split('\n').slice(0, TSC_HEAD_LINES).join('\n') };
}

export function ruleCheckLines(repo: string, reviewBase: string, tree: string): string[] {
  const completed = spawnSync(process.execPath, [RULE_CHECKS, '--repo', repo, '--base', reviewBase, '--head', tree], { encoding: 'utf8' });
  if (completed.error) throw completed.error;
  const lines = completed.stdout.split('\n').filter((line) => line !== '');
  const exit = completed.status === 0 ? [] : [`exit ${completed.status}: ${completed.stderr.trim()}`];
  return [...lines, ...exit].map((line) => `rule-checks ${line}`);
}

function tscPath(repo: string): string {
  const repoTsc = join(repo, 'node_modules', '.bin', 'tsc');
  return existsSync(repoTsc) ? repoTsc : join(KEEL_ROOT, 'node_modules', '.bin', 'tsc');
}
