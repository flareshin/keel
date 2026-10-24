import { buildChains } from './chain.ts';
import type { Chain } from './chain.ts';
import * as codexReview from './codex_review.ts';
import * as commentCleanup from './comment_cleanup.ts';
import * as gitcmd from './gitcmd.ts';
import type { PathEntry } from './gitcmd.ts';
import { pyRepr, sortedStrings } from './pycompat.ts';
import * as registry from './registry.ts';
import type { GatedRepo } from './registry.ts';
import { LIGHT, SMOKE_ONLY, classify, hasTestPath, logicPaths } from './risk.ts';
import type { Risk } from './risk.ts';
import * as store from './store.ts';
import type { Evidence } from './store.ts';
import * as writers from './writers.ts';
import { NO_TEST_REASON } from './writers.ts';

export const K1 = 'K1';
export const K3 = 'K3';
export const RISK = 'risk';
const PASS = 'PASS';
const LENS_REVIEW = 'lens-review';
const GATE_SMOKE = 'smoke';
const PATHS_SHOWN = 8;
const COMMIT_ABBREVIATION = 10;

export interface Reason {
  ruleId: string;
  text: string;
}

export interface Outgoing {
  repoRoot: string;
  repoKey: string;
  row: GatedRepo;
  head: string;
  mergeBase: string;
  needsApproval: boolean;
}

export interface Decision {
  ok: boolean;
  reasons: Reason[];
  riskClass: string | null;
  rootRunId: string | null;
  files: number;
  lines: number;
  k3Waiver: string | null;
  rootRunIds: string[];
}

type Predecessor = [base: string, rootRunId: string];

export function judge(outgoing: Outgoing): Decision {
  const entries = gitcmd.diffEntries(outgoing.repoRoot, outgoing.mergeBase, outgoing.head);
  if (entries.length === 0) {
    return { ok: true, reasons: [], riskClass: null, rootRunId: null, files: 0, lines: 0, k3Waiver: null, rootRunIds: [] };
  }
  const stats = gitcmd.diffStats(outgoing.repoRoot, outgoing.mergeBase, outgoing.head);
  const risk = classify(entries, stats, registry.riskRules(outgoing.row.riskRules));
  if (outgoing.row.gate === GATE_SMOKE || risk.riskClass === SMOKE_ONLY) {
    const reasons = smokeReasons(outgoing, entries);
    return { ok: reasons.length === 0, reasons, riskClass: risk.riskClass, rootRunId: null, files: risk.files, lines: risk.lines, k3Waiver: null, rootRunIds: [] };
  }
  const [chain, roots, resolved] = resolveReviews(outgoing, entries);
  const reasons = [...resolved, ...testReasons(outgoing, entries, risk)];
  const waiver = noTestReason(chain);
  const unchangedLogic = new Set(entries
    .filter((entry) => !gitcmd.isDeleted(entry)
      && commentCleanup.matchesContent(outgoing.repoRoot, entry.path, gitcmd.treeEntry(outgoing.repoRoot, outgoing.mergeBase, entry.path),
        [entry.mode, entry.blob]))
    .map((entry) => entry.path));
  reasons.push(...sameRangeTestReasons(risk, waiver, unchangedLogic));
  const usedWaiver = logicPaths(risk).length > 0 && !hasTestPath(risk) ? waiver : null;
  return {
    ok: reasons.length === 0, reasons, riskClass: risk.riskClass, rootRunId: chain ? chain.rootRunId : null,
    files: risk.files, lines: risk.lines, k3Waiver: usedWaiver, rootRunIds: roots,
  };
}

export function covers(repoRoot: string, tree: string, entries: PathEntry[]): boolean {
  try {
    return entries.every((entry) => commentCleanup.matchesContent(repoRoot, entry.path, gitcmd.treeEntry(repoRoot, tree, entry.path),
      gitcmd.isDeleted(entry) ? null : [entry.mode, entry.blob]));
  } catch (error) {
    if (error instanceof gitcmd.GitError) return false;
    throw error;
  }
}

export function boundEvidence(kind: string, rootRunId: string, repoKey: string, headId: string): Evidence | null {
  return store.load(kind).reverse()
    .find((evidence) => evidence['root_run_id'] === rootRunId && evidence['heads'][repoKey] === headId) ?? null;
}

function resolveReviews(outgoing: Outgoing, entries: PathEntry[]): [Chain | null, string[], Reason[]] {
  const chains = buildChains(store.loadReviews(outgoing.repoKey));
  const [chain, reasons] = bestChain(outgoing, entries, chains);
  if (reasons.length === 0) return [chain, [chain!.rootRunId], reasons];
  const stackable = stackableChains(outgoing, chains);
  const series = approvedSeries(outgoing, chains, stackable);
  if (series.length > 0) return [null, series, []];
  return [chain, [], [...reasons, ...stackedOverlapReasons(outgoing, entries, stackable, chains)]];
}

function stackedOverlapReasons(outgoing: Outgoing, entries: PathEntry[], stackable: Chain[], chains: Chain[]): Reason[] {
  const reasons: Reason[] = [];
  for (const entry of entries) {
    const reviewers = sortedStrings(stackable.filter((chain) => chain.reviewed.has(entry.path)).map((chain) => chain.rootRunId));
    if (gitcmd.isGitlink(entry) || reviewers.length < 2 || coveredByAny(outgoing, entry, chains)) continue;
    const commit = gitcmd.lastCommitTouching(outgoing.repoRoot, outgoing.mergeBase, outgoing.head, entry.path);
    const parent = gitcmd.commitSha(outgoing.repoRoot, commit + '^');
    reasons.push({
      ruleId: K1,
      text: `${entry.path}: chains ${reviewers.join(', ')} each reviewed it, but no review saw the stacked content; review commit `
        + `${commit.slice(0, COMMIT_ABBREVIATION)} from its parent ${parent!.slice(0, COMMIT_ABBREVIATION)}, then approve that review`,
    });
  }
  return reasons;
}

function coveredByAny(outgoing: Outgoing, entry: PathEntry, chains: Chain[]): boolean {
  const approved = { ...outgoing, needsApproval: true };
  return chains.some((chain) => coverageReasons(chain, [entry], outgoing.repoRoot).length === 0
    && gitcmd.isAncestor(outgoing.repoRoot, chain.root.review_base, outgoing.head)
    && chainLevelReasons(approved, chain).length === 0);
}

function approvedSeries(outgoing: Outgoing, chains: Chain[], stackable: Chain[]): string[] {
  const changes = new Map<string, PathEntry[]>();
  const pending: Array<[string, string[]]> = [[outgoing.head, []]];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const [boundary, suffix] = pending.shift()!;
    if (boundary === outgoing.mergeBase) return suffix;
    if (visited.has(boundary)) continue;
    visited.add(boundary);
    for (const [base, root] of approvedPredecessors(outgoing, boundary, chains, stackable, changes)) {
      pending.push([base, [root, ...suffix]]);
    }
  }
  return [];
}

function* approvedPredecessors(outgoing: Outgoing, boundary: string, chains: Chain[], stackable: Chain[],
  changes: Map<string, PathEntry[]>): Generator<Predecessor> {
  yield* consecutivePredecessors(outgoing, boundary, chains);
  if (stackable.length > 0) yield* stackedPredecessors(outgoing, boundary, stackable, changes);
}

function stackableChains(outgoing: Outgoing, chains: Chain[]): Chain[] {
  const approved = { ...outgoing, needsApproval: true };
  return chains.filter((chain) => gitcmd.isAncestor(outgoing.repoRoot, chain.root.review_base, outgoing.mergeBase)
    && chainLevelReasons(approved, chain).length === 0);
}

function* stackedPredecessors(outgoing: Outgoing, boundary: string, stackable: Chain[],
  changes: Map<string, PathEntry[]>): Generator<Predecessor> {
  const parents = gitcmd.firstParentAncestors(outgoing.repoRoot, boundary, outgoing.mergeBase);
  const atBoundary = new Map<string, PathEntry>();
  const atStart = new Map<string, [string | null, string]>();
  const commits = [boundary, ...parents.slice(0, -1)];
  for (let index = 0; index < Math.min(commits.length, parents.length); index++) {
    const commit = commits[index]!;
    const parent = parents[index]!;
    if (!changes.has(commit)) changes.set(commit, gitcmd.diffEntries(outgoing.repoRoot, parent, commit));
    for (const entry of changes.get(commit)!) {
      if (!atBoundary.has(entry.path)) atBoundary.set(entry.path, entry);
      atStart.set(entry.path, [entry.oldBlob, entry.oldMode]);
    }
    const net = [...atBoundary].filter(([path, entry]) => {
      const start = atStart.get(path)!;
      return entry.blob !== start[0] || entry.mode !== start[1];
    }).map(([, entry]) => entry);
    for (const chain of stackable) {
      if (reviewsEveryPath(chain, net) && coverageReasons(chain, net, outgoing.repoRoot).length === 0) {
        yield [parent, chain.rootRunId];
      }
    }
  }
}

function reviewsEveryPath(chain: Chain, entries: PathEntry[]): boolean {
  return entries.every((entry) => gitcmd.isGitlink(entry) || chain.reviewed.has(entry.path));
}

function* consecutivePredecessors(outgoing: Outgoing, boundary: string, chains: Chain[]): Generator<Predecessor> {
  const tree = gitcmd.treeOfCommit(outgoing.repoRoot, boundary);
  for (const [base, basedChains] of byReviewBase(chains)) {
    if (base === boundary) continue;
    if (!gitcmd.isAncestor(outgoing.repoRoot, outgoing.mergeBase, base)) continue;
    if (!gitcmd.isAncestor(outgoing.repoRoot, base, boundary)) continue;
    const interval = { ...outgoing, head: boundary, mergeBase: base, needsApproval: true };
    const entries = gitcmd.diffEntries(outgoing.repoRoot, base, boundary);
    for (const chain of basedChains) {
      if (!reviewsEveryPath(chain, entries)) continue;
      const reviewedTree = chain.head.reviewed_tree;
      if (reviewedTree !== tree && !covers(outgoing.repoRoot, reviewedTree, gitcmd.diffEntries(outgoing.repoRoot, reviewedTree, tree))) continue;
      if (chainReasons(interval, chain, entries).length === 0) yield [base, chain.rootRunId];
    }
  }
}

function byReviewBase(chains: Chain[]): Map<string, Chain[]> {
  const grouped = new Map<string, Chain[]>();
  for (const chain of chains) {
    const base = chain.root.review_base;
    grouped.set(base, [...(grouped.get(base) ?? []), chain]);
  }
  return grouped;
}

function bestChain(outgoing: Outgoing, entries: PathEntry[], chains: Chain[]): [Chain | null, Reason[]] {
  if (chains.length === 0) {
    return [null, [{ ruleId: K1, text: `no review evidence for ${outgoing.repoKey}: run lens-review on this change` }]];
  }
  const judged = chains.map((chain): [Chain, Reason[]] => [chain, chainReasons(outgoing, chain, entries)]);
  const clean = judged.find(([, reasons]) => reasons.length === 0);
  if (clean) return [clean[0], []];
  const best = judged.find(([chain]) => coverageReasons(chain, entries, outgoing.repoRoot).length === 0) ?? judged[0]!;
  return best;
}

function chainReasons(outgoing: Outgoing, chain: Chain, entries: PathEntry[]): Reason[] {
  const reasons = verdictReasons(chain);
  if (!gitcmd.isAncestor(outgoing.repoRoot, chain.root.review_base, outgoing.mergeBase)) {
    reasons.push({
      ruleId: K1,
      text: `chain ${chain.rootRunId} reviewed from ${chain.root.review_base.slice(0, COMMIT_ABBREVIATION)}, `
        + `not from the merge base ${outgoing.mergeBase.slice(0, COMMIT_ABBREVIATION)} or an ancestor of it`,
    });
  }
  reasons.push(...coverageReasons(chain, entries, outgoing.repoRoot));
  return [...reasons, ...kindReasons(chain), ...provenanceReasons(chain), ...approvalReasons(outgoing, chain)];
}

function chainLevelReasons(outgoing: Outgoing, chain: Chain): Reason[] {
  return [...verdictReasons(chain), ...kindReasons(chain), ...provenanceReasons(chain), ...approvalReasons(outgoing, chain)];
}

function verdictReasons(chain: Chain): Reason[] {
  if (chain.head.verdict === PASS) return [];
  return [{ ruleId: K1, text: `chain ${chain.rootRunId} ends in ${chain.head.verdict}: a delta review must pass first` }];
}

function kindReasons(chain: Chain): Reason[] {
  if (chain.links.every((link) => link.review_kind === LENS_REVIEW || link.review_kind === codexReview.KIND)) return [];
  return [{ ruleId: RISK, text: `every change needs a lens-review chain; chain ${chain.rootRunId} has a single-lens link` }];
}

function coverageReasons(chain: Chain, entries: PathEntry[], repo: string): Reason[] {
  const missing: string[] = [];
  for (const entry of entries) {
    if (gitcmd.isGitlink(entry)) continue;
    const reviewed = chain.reviewed.get(entry.path);
    if (reviewed === undefined) {
      missing.push(`${entry.path} (not in any reviewed diff)`);
    } else if (gitcmd.isDeleted(entry) && reviewed[0] !== null) {
      missing.push(`${entry.path} (deletion not reviewed)`);
    } else if (!gitcmd.isDeleted(entry)
      && !commentCleanup.matchesContent(repo, entry.path, [reviewed[1], reviewed[0]], [entry.mode, entry.blob])) {
      missing.push(`${entry.path} (content or mode changed after review)`);
    }
  }
  if (missing.length === 0) return [];
  return [{ ruleId: K1, text: `chain ${chain.rootRunId} does not cover: ${shown(missing)}` }];
}

export function provenanceReasons(chain: Chain): Reason[] {
  for (const link of chain.links) {
    if (link.review_kind === codexReview.KIND || (link.source || {})['via'] === codexReview.VIA) {
      try {
        codexReview.validateEvidence(link);
      } catch (error) {
        if (isValidationFailure(error)) return [{ ruleId: K1, text: `invalid Codex provenance: ${failureText(error)}` }];
        throw error;
      }
    }
    if (!(link.source || {})['agent_id']) {
      return [{ ruleId: K1, text: `review ${link.evidence_id} has no agent provenance` }];
    }
  }
  return [];
}

export function isValidationFailure(error: unknown): boolean {
  return error instanceof writers.Refused || writers.isInputFailure(error);
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : pyRepr(String(error));
}

function approvalReasons(outgoing: Outgoing, chain: Chain): Reason[] {
  const headId = chain.head.evidence_id;
  if (!outgoing.needsApproval || boundEvidence('approval', chain.rootRunId, outgoing.repoKey, headId)) return [];
  return [{ ruleId: K1, text: `no approval bound to chain head ${headId}: run \`keel approve ${chain.rootRunId}\`` }];
}

function testReasons(outgoing: Outgoing, entries: PathEntry[], risk: Risk): Reason[] {
  if (risk.riskClass === LIGHT && !registry.testsRequired(outgoing.row)) return [];
  if (!registry.testsRequired(outgoing.row)) {
    return [{ ruleId: K3, text: `add test infrastructure first: ${outgoing.repoKey} has tests=none and the change is ${risk.riskClass}` }];
  }
  if (coveredBy('tests', outgoing, entries)) return [];
  return [{ ruleId: K3, text: 'no tests evidence covers this exact content: run `keel test -- <test command>`' }];
}

function sameRangeTestReasons(risk: Risk, waiver: string | null, unchangedLogic: Set<string>): Reason[] {
  const logic = logicPaths(risk).filter((path) => !unchangedLogic.has(path));
  if (logic.length === 0 || hasTestPath(risk) || waiver) return [];
  return [{
    ruleId: K3,
    text: `logic changed with no test in the same range: ${shown(logic)}; add a test, or have the reviewer state ${NO_TEST_REASON} in KEEL-EVIDENCE`,
  }];
}

function noTestReason(chain: Chain | null): string | null {
  return chain ? (chain.head[NO_TEST_REASON] ?? null) : null;
}

function coveredBy(kind: string, outgoing: Outgoing, entries: PathEntry[]): boolean {
  return store.load(kind, outgoing.repoKey).reverse().some((evidence) => covers(outgoing.repoRoot, evidence['tree'], entries));
}

function smokeReasons(outgoing: Outgoing, entries: PathEntry[]): Reason[] {
  if (coveredBy('smoke', outgoing, entries)) return [];
  return [{ ruleId: RISK, text: 'no smoke evidence covers this exact content: run measure/smoke, then `keel evidence write-smoke`' }];
}

function shown(items: string[]): string {
  let text = items.slice(0, PATHS_SHOWN).join(', ');
  if (items.length > PATHS_SHOWN) text += `, +${items.length - PATHS_SHOWN} more`;
  return text;
}
