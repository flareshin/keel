import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCaptured } from '../evidence/subprocess.ts';
import type { Completed } from '../evidence/subprocess.ts';

export type Typecheck = { ok: true } | { ok: false; head: string };

const KEEL_ROOT = join(import.meta.dirname, '..', '..');
const RULE_CHECKS = join(KEEL_ROOT, 'skills', 'readable-code', 'scripts', 'rule-checks.ts');
const TSC_HEAD_LINES = 20;
const REVIEW_SUMMARY_PREFIX = /^summary /;
const PRECHECK_SUMMARY_PREFIX = 'totals ';

export function typecheck(repo: string): Typecheck {
  if (!existsSync(join(repo, 'tsconfig.json'))) return { ok: true };
  const completed = runCaptured([tscPath(repo), '--noEmit', '-p', repo], { cwd: repo });
  if (completed.returncode === 0) return { ok: true };
  return { ok: false, head: nonEmptyLines(`${completed.stdout}${completed.stderr}`).slice(0, TSC_HEAD_LINES).join('\n') };
}

export function ruleCheckLines(repo: string, reviewBase: string, tree: string): string[] {
  return ruleCheckOutputLines(runCaptured([process.execPath, RULE_CHECKS, '--repo', repo, '--base', reviewBase, '--head', tree]));
}

export function ruleCheckOutputLines(completed: Completed): string[] {
  const exit = completed.returncode === 0 ? [] : [`exit ${completed.returncode}`, ...nonEmptyLines(completed.stderr.toString('utf8'))];
  const scanned = nonEmptyLines(completed.stdout.toString('utf8')).map((line) => line.replace(REVIEW_SUMMARY_PREFIX, PRECHECK_SUMMARY_PREFIX));
  return [...scanned, ...exit].map((line) => `rule-checks ${line}`);
}

function tscPath(repo: string): string {
  const repoTsc = join(repo, 'node_modules', '.bin', 'tsc');
  return existsSync(repoTsc) ? repoTsc : join(KEEL_ROOT, 'node_modules', '.bin', 'tsc');
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}
