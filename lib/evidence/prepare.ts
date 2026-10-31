import { join } from 'node:path';
import { readUtf8 } from '../../measure/lib/measurekit/files.ts';
import { parseJsonKeepingIntegers } from '../../measure/lib/measurekit/json.ts';
import { bindPrecheck, precheckRequirement, precheckTreeOf } from '../precheck/binding.ts';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import * as registry from './registry.ts';
import * as risk from './risk.ts';
import * as writers from './writers.ts';
import { isJsonRecord } from './writers.ts';
import type { JsonObject } from './writers.ts';

const TARGET_KEYS = new Set(['repo', 'base', 'head', 'since']);

export function review(request: JsonObject): JsonObject {
  const diffs = request['diffs'];
  if (!Array.isArray(diffs) || diffs.length === 0) throw new writers.Usage('review prepare needs a nonempty diffs list');
  const precheckTree = typeof request['precheck'] === 'string' ? precheckTreeOf(request['precheck']) : null;
  const prepared = diffs.map(prepareTarget).map((target) => precheckTree ? withPrecheckBinding(target, precheckTree) : target);
  const requirable = request['precheck'] === undefined && prepared.length === 1 && !diffs[0]['since'];
  const targets = requirable ? prepared.map(withPrecheckRequirement) : prepared;
  const lensesPath = join(env.dataDir(), 'workflows/review-lenses.json');
  const lenses: JsonObject = 'lenses' in request ? {} : parseJsonKeepingIntegers(readUtf8(lensesPath)) as JsonObject;
  return {
    diff_outputs: targets.map((target) => JSON.stringify(target)),
    run_id_output: env.newId('rv', env.utcNow(), env.RUN_ID_RANDOM_BYTES),
    lenses_output: { lenses: lenses['lenses'] ?? [], guardrails: lenses['guardrails'] ?? '' },
    needs_fixes_rounds: countNeedsFixesRounds(request['rootRunId']),
    risk_class: reviewRiskClass(targets),
  };
}

function withPrecheckBinding(target: JsonObject, precheckTree: string): JsonObject {
  const end = target['head'] || target['snapshot_tree'];
  return { ...target, precheck_binding: bindPrecheck(target['repo_root'], target['review_base'], end, precheckTree) };
}

function withPrecheckRequirement(target: JsonObject): JsonObject {
  const end = target['head'] || target['snapshot_tree'];
  try {
    return { ...target, precheck_required: { ...precheckRequirement(target['repo_root'], target['review_base'], end) } };
  } catch (error) {
    if (error instanceof gitcmd.GitError) return { ...target, precheck_required: null };
    throw error;
  }
}

export function countNeedsFixesRounds(rootRunId: unknown): number {
  if (typeof rootRunId !== 'string') return 0;
  const rounds = [...writers.newestChains(rootRunId).values()]
    .map((chain) => chain.links.filter((link) => link.verdict === 'NEEDS_FIXES').length);
  return Math.max(0, ...rounds);
}

export function prepareTarget(target: JsonObject): JsonObject {
  if (!isJsonRecord(target) || Object.keys(target).some((key) => !TARGET_KEYS.has(key))) {
    throw new writers.Usage('invalid review target');
  }
  if (typeof target['repo'] !== 'string') throw new writers.Usage('target repository must be a path');
  const repo = gitcmd.toplevel(target['repo']);
  const base = target['base'];
  if (repo === null || typeof base !== 'string' || base.startsWith('-')) throw new writers.Usage('target needs a repository and base ref');
  const head = target['head'] ?? null;
  if (head !== null && (typeof head !== 'string' || head.startsWith('-'))) throw new writers.Usage('invalid head ref');
  const end = head ? gitcmd.commitSha(repo, head) : gitcmd.snapshotTree(repo);
  if (!end) throw new writers.Refused('review head does not exist');
  const start = gitcmd.mergeBase(repo, base, head ? end : 'HEAD');
  if (!end || !start) throw new writers.Refused('review target objects do not exist');
  const since = target['since'] ?? null;
  if (since !== null && (!env.isSha(since) || gitcmd.objectType(repo, since) !== 'tree')) {
    throw new writers.Refused('since must be a recorded snapshot tree');
  }
  const stat = gitcmd.text(repo, ['diff', '--shortstat', since || start, end]).trim();
  return { repo_root: repo, review_base: start, head: head ? end : null, snapshot_tree: head ? null : end, diff_stat: stat };
}

export function reviewRiskClass(targets: JsonObject[]): string | null {
  const classes = targets.map(repoRiskClass);
  if (classes.includes(null)) return null;
  return (classes as string[]).reduce((best, item) => risk.CLASS_ORDER.indexOf(item) > risk.CLASS_ORDER.indexOf(best) ? item : best);
}

export function repoRiskClass(target: JsonObject): string | null {
  const repo = target['repo_root'];
  const row = registry.lookup(registry.originKey(repo));
  if (!row || !registry.isGated(row)) return null;
  const end = target['head'] || target['snapshot_tree'];
  const entries = gitcmd.diffEntries(repo, target['review_base'], end);
  const stats = gitcmd.diffStats(repo, target['review_base'], end);
  return risk.classify(entries, stats, registry.riskRules(row.riskRules)).riskClass;
}
