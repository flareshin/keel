import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildChains } from './chain.ts';
import type { Chain } from './chain.ts';
import * as codexReview from './codex_review.ts';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import { decodeStrict, expandUser, pyRealpath, pyStrip, pythonJsonLoads, sortedStrings, universalNewlines } from './pycompat.ts';
import * as registry from './registry.ts';
import * as store from './store.ts';
import type { ReviewEvidence } from './store.ts';

export type JsonObject = Record<string, any>;

const REVIEW_CLAIM_KEYS = ['v', 'repo_root', 'review_base', 'head', 'snapshot_tree', 'since', 'run_id', 'root_run_id', 'review_kind'];
export const NO_TEST_REASON = 'no_test_reason';
const SOURCE_KEYS = ['session_id', 'agent_id', 'agent_type', 'transcript_path', 'agent_transcript_path', 'via'];
const REVIEW_KINDS = ['lens-review', 'single-lens'];
const VERDICTS = ['PASS', 'NEEDS_FIXES'];
const VIAS = ['SubagentHandback', 'SubagentStop'];
const APPROVAL_SOURCE = 'cli';

export class Refused extends Error {}

export class Usage extends Error {}

export function writeReview(request: JsonObject): JsonObject {
  const claim = validatedClaim(request['keel_evidence']);
  const verdict = request['verdict'];
  if (!VERDICTS.includes(verdict)) throw new Usage(`verdict must be one of ${VERDICTS.join(', ')}`);
  const source = validatedSource(request['source']);
  checkProvenance(source);
  const [repoRoot, repoKey] = repoOf(claim['repo_root']);
  checkObjects(repoRoot, claim);
  const reviewedTree = claim['head'] ? gitcmd.treeOfCommit(repoRoot, claim['head']) : claim['snapshot_tree'];
  const [sinceId, sinceTree] = resolveSince(repoKey, claim);
  const duplicate = sameReview(repoKey, claim['run_id'], reviewedTree);
  if (duplicate) return { evidence_id: duplicate.evidence_id, repo: repoKey, paths: duplicate.paths.length };
  const diffFrom = sinceTree || claim['review_base'];
  const paths = gitcmd.diffEntries(repoRoot, diffFrom, reviewedTree)
    .map((entry) => ({ path: entry.path, blob: entry.blob, mode: entry.mode }));
  const body = {
    repo: repoKey, repo_root: repoRoot, run_id: claim['run_id'], root_run_id: claim['root_run_id'],
    since: sinceId, since_tree: sinceTree, review_base: claim['review_base'], head: claim['head'],
    snapshot_tree: claim['snapshot_tree'], reviewed_tree: reviewedTree,
    review_kind: claim['review_kind'], verdict, paths, source,
    [NO_TEST_REASON]: claim[NO_TEST_REASON] ?? null,
  };
  const evidence = store.write('review', body, repoKey);
  return { evidence_id: evidence.evidence_id, repo: repoKey, paths: paths.length };
}

export function checkProvenance(source: JsonObject): void {
  if (!source['agent_id']) throw new Refused('no agent_id: review evidence comes from a subagent, never the main thread');
  const agent = pyRealpath(expandUser(source['agent_transcript_path']));
  if (!isFile(agent)) throw new Refused('agent transcript does not exist: ' + agent);
}

export function writeSmoke(repoPath: string, runId: string | null): JsonObject {
  const [repoRoot, repoKey] = repoOf(repoPath);
  const run = smokeRun(runId);
  if (run === null) throw new Refused(`no smoke run ${runId || '(latest)'} in keel-smoke.jsonl`);
  if (!run['ok']) throw new Refused(`smoke run ${run['run_id']} failed`);
  const tree = (run['trees'] || {})[repoKey];
  if (!tree) throw new Refused(`smoke run ${run['run_id']} did not cover ${repoKey}`);
  const evidence = store.write('smoke', { repo: repoKey, repo_root: repoRoot, run_id: run['run_id'], tree }, repoKey);
  return { evidence_id: evidence.evidence_id, repo: repoKey, tree };
}

export function writeApproval(rootRunId: string, kind: string): JsonObject {
  if (!env.matchesRunId(rootRunId || '')) throw new Usage(`root_run_id must match ${env.RUN_ID_PATTERN}`);
  const heads = chainHeads(rootRunId);
  if (heads.size === 0) throw new Refused('no review chain with root ' + rootRunId);
  const failing = sortedStrings([...heads].filter(([, head]) => head.verdict !== 'PASS').map(([key]) => key));
  if (failing.length > 0) throw new Refused('chain head is not PASS for ' + failing.join(', '));
  for (const head of heads.values()) {
    if (head['review_kind'] === codexReview.KIND || (head.source || {})['via'] === codexReview.VIA) {
      codexReview.validateEvidence(head);
    }
  }
  const pinned = Object.fromEntries([...heads].map(([key, head]) => [key, head.evidence_id]));
  const commits: Record<string, string> = {};
  for (const [key, head] of heads) {
    const commit = gitcmd.commitSha(head.repo_root, 'HEAD');
    if (commit && gitcmd.treeOfCommit(head.repo_root, commit) === head.reviewed_tree) commits[key] = commit;
  }
  const evidence = store.write(kind, {
    root_run_id: rootRunId, heads: pinned, source: APPROVAL_SOURCE, session_id: null, commits,
  });
  return { evidence_id: evidence.evidence_id, kind, root_run_id: rootRunId, heads: pinned };
}

export function chainHeads(rootRunId: string): Map<string, ReviewEvidence> {
  return new Map([...newestChains(rootRunId)].map(([key, chain]) => [key, chain.head]));
}

export function newestChains(rootRunId: string): Map<string, Chain> {
  const chains = new Map<string, Chain>();
  for (const repoKey of store.repoKeys('review')) {
    const match = buildChains(store.loadReviews(repoKey)).find((chain) => chain.rootRunId === rootRunId);
    if (match) chains.set(repoKey, match);
  }
  return chains;
}

function validatedClaim(claim: any): JsonObject {
  const isObject = claim !== null && typeof claim === 'object' && !Array.isArray(claim);
  const claimKeys = isObject ? Object.keys(claim).filter((key) => key !== NO_TEST_REASON) : [];
  if (!isObject || claimKeys.length !== REVIEW_CLAIM_KEYS.length || !REVIEW_CLAIM_KEYS.every((key) => claimKeys.includes(key))) {
    throw new Usage(`keel_evidence must have exactly the keys ${REVIEW_CLAIM_KEYS.join(', ')} (plus optional ${NO_TEST_REASON})`);
  }
  const reason = claim[NO_TEST_REASON];
  if (reason !== undefined && reason !== null && !(typeof reason === 'string' && pyStrip(reason))) {
    throw new Usage(`${NO_TEST_REASON} must be a non-empty string`);
  }
  if (claim['v'] !== 1 && claim['v'] !== true) throw new Usage('keel_evidence.v must be 1');
  if ((claim['head'] === null) === (claim['snapshot_tree'] === null)) {
    throw new Usage('exactly one of head and snapshot_tree must be set');
  }
  for (const key of ['review_base', 'head', 'snapshot_tree', 'since']) {
    if (claim[key] !== null && !env.matchesSha(pyStr(claim[key]))) throw new Usage(`${key} must be a 40-hex id`);
  }
  for (const key of ['run_id', 'root_run_id']) {
    if (!env.matchesRunId(pyStr(claim[key]))) throw new Usage(`${key} must match ${env.RUN_ID_PATTERN}`);
  }
  if (!REVIEW_KINDS.includes(claim['review_kind'])) throw new Usage('review_kind must be one of ' + REVIEW_KINDS.join(', '));
  if (claim['since'] === null && claim['run_id'] !== claim['root_run_id']) {
    throw new Refused('a root review needs root_run_id == run_id');
  }
  return claim;
}

function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  return '[unrepresentable]';
}

function validatedSource(source: any): JsonObject {
  const keys = source !== null && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source) : [];
  if (keys.length !== SOURCE_KEYS.length || !SOURCE_KEYS.every((key) => keys.includes(key))) {
    throw new Usage('source must have exactly the keys ' + SOURCE_KEYS.join(', '));
  }
  for (const key of ['session_id', 'transcript_path', 'agent_transcript_path']) {
    if (!source[key] || typeof source[key] !== 'string') throw new Usage(`source.${key} must be a non-empty string`);
  }
  if (!VIAS.includes(source['via'])) throw new Usage('source.via must be one of ' + VIAS.join(', '));
  if (source['agent_id'] !== null && typeof source['agent_id'] !== 'string') throw new Usage('source.agent_id must be a string');
  return source;
}

export function repoOf(path: string): [repoRoot: string, repoKey: string] {
  const repoRoot = gitcmd.toplevel(path);
  if (repoRoot === null || repoRoot !== pyRealpath(path)) throw new Refused(`${path} is not the root of a git repository`);
  const repoKey = registry.originKey(repoRoot);
  if (repoKey === null) throw new Refused(`${repoRoot} has no origin remote to name the repo by`);
  return [repoRoot, repoKey];
}

function checkObjects(repoRoot: string, claim: JsonObject): void {
  const expected: Array<[string, string]> = [['review_base', 'commit'], ['head', 'commit'], ['snapshot_tree', 'tree'], ['since', 'tree']];
  for (const [key, kind] of expected) {
    if (claim[key] !== null && gitcmd.objectType(repoRoot, claim[key]) !== kind) {
      throw new Refused(`${key} ${claim[key]} is not a ${kind} in ${repoRoot}`);
    }
  }
}

function resolveSince(repoKey: string, claim: JsonObject): [string | null, string | null] {
  if (claim['since'] === null) return [null, null];
  for (const review of store.loadReviews(repoKey).reverse()) {
    if (review.root_run_id === claim['root_run_id'] && review.reviewed_tree === claim['since']) {
      return [review.evidence_id, claim['since']];
    }
  }
  throw new Refused(`no review of root ${claim['root_run_id']} reviewed tree ${claim['since']}`);
}

export function sameReview(repoKey: string, runId: string, reviewedTree: string): ReviewEvidence | null {
  return store.loadReviews(repoKey).find((review) => review.run_id === runId && review.reviewed_tree === reviewedTree) ?? null;
}

function smokeRun(runId: string | null): JsonObject | null {
  const path = join(env.logsDir(), 'keel-smoke.jsonl');
  if (!isFile(path)) return null;
  const runs = splitOnNewline(universalNewlines(decodeStrict(readFileSync(path))))
    .filter((line) => pyStrip(line)).map((line) => pythonJsonLoads(line) as JsonObject);
  const matching = runs.filter((run) => runId === null || run['run_id'] === runId);
  return matching.at(-1) ?? null;
}

function splitOnNewline(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
