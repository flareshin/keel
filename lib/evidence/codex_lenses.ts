import { isDeepStrictEqual } from 'node:util';
import { compareCodePoints } from '../../measure/lib/measurekit/json.ts';
import * as codexReview from './codex_review.ts';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import * as store from './store.ts';
import * as writers from './writers.ts';
import { isJsonRecord } from './writers.ts';
import type { JsonObject } from './writers.ts';

const SOURCE_KEYS = new Set(['version', 'via', 'session_id', 'agent_id', 'reviewers']);
const REVIEWER_KEYS = new Set(['session_id', 'path', 'sha256']);
const TARGET_FIELDS = ['base', 'tree', 'since_tree', 'root_run_id'];
const RUN_ID_PREFIX = 'cx2-';
const RUN_ID_DIGEST_LENGTH = 32;
const BLOCKING_IMPACTS = ['high', 'medium'];

export interface Review {
  identity: string;
  path: string;
  sha256: string;
  meta: JsonObject;
  report: JsonObject;
}

export interface Bundle {
  author: string;
  base: string;
  tree: string;
  sinceTree: string | null;
  rootRunId: string;
  previous: JsonObject | null;
  findings: Record<string, JsonObject[]>;
}

type Target = Array<string | null>;

function reportKeys(): Set<string> {
  return new Set([...codexReview.REPORT_KEYS, 'since_tree', 'root_run_id']);
}

export function register(repoPath: string, auditIds: string[], verifierIds: string[]): JsonObject {
  const [repo, key] = writers.repoOf(repoPath);
  const reviews = loadReviews([...auditIds, ...verifierIds]);
  if (reviews.slice(0, auditIds.length).some((review) => review.report['role'] !== 'audit')) {
    throw new writers.Refused('--audits must name audit children');
  }
  if (reviews.slice(auditIds.length).some((review) => review.report['role'] !== 'verify')) {
    throw new writers.Refused('--verifiers must name verifier children');
  }
  const runId = reviewRunId(reviews);
  const existing = writers.sameReview(key, runId, reviews[0]!.report['tree']);
  const bundle = existing ? validateEvidence(existing) : analyze(repo, key, reviews, new Set());
  const caller = process.env['CODEX_THREAD_ID'];
  if (caller && caller !== bundle.author) throw new writers.Refused('review belongs to a different author session');
  if (gitcmd.snapshotTree(repo) !== bundle.tree) throw new writers.Refused('working tree changed after the review');
  const body = buildBody(repo, key, bundle, reviews);
  let evidence: JsonObject;
  if (existing) {
    if (Object.entries(body).some(([name, value]) => !isDeepStrictEqual(existing[name] ?? null, value))) {
      throw new writers.Refused('existing review differs from the requested completed children');
    }
    evidence = existing;
  } else {
    evidence = store.write('review', body, key);
  }
  return { evidence_id: evidence['evidence_id'], root_run_id: bundle.rootRunId, verdict: evidence['verdict'], paths: evidence['paths'].length };
}

export function loadReviews(identities: string[]): Review[] {
  if (identities.length === 0 || identities.length !== new Set(identities).size) {
    throw new writers.Refused('review children must be nonempty and distinct');
  }
  return identities.map((identity) => {
    const [path, content] = codexReview.locateSession(identity);
    const [meta, report] = codexReview.completedReport(content, identity);
    return { identity, path, sha256: codexReview.digest(content), meta, report };
  });
}

export function analyze(repo: string, key: string, reviews: Review[], trail: Set<string>, previousId: string | null = null): Bundle {
  const author = sharedAuthor(reviews);
  const first = reviews[0]!.report;
  const target: Target = TARGET_FIELDS.map((name) => first[name] ?? null);
  const audits = new Map<string, Review>();
  const verifiers = new Map<string, Review>();
  for (const review of reviews) {
    validateReport(review.report, repo, target);
    const report = review.report;
    if (report['role'] === 'audit') {
      for (const lens of Object.keys(report['lenses'])) {
        if (audits.has(lens)) throw new writers.Refused('each lens needs exactly one independent auditor');
        audits.set(lens, review);
      }
    } else {
      const identity = report['audit_session'];
      if (verifiers.has(identity)) throw new writers.Refused('each nonempty audit gets one batched verifier');
      verifiers.set(identity, review);
    }
  }
  if (!sameMembers([...audits.keys()], codexReview.LENSES)) throw new writers.Refused('native audit must cover all five lenses exactly once');
  const expected = new Set([...audits.values()].filter((review) => review.report['findings'].length > 0).map((review) => review.identity));
  if (!sameMembers([...verifiers.keys()], expected)) {
    throw new writers.Refused('verify exactly the audits with findings; clean audits need no verifier');
  }
  const [base, tree, sinceTree, root] = target as [string, string, string | null, string | null];
  const [previous, priorFindings] = priorReview(key, base, sinceTree, root, trail, previousId);
  const findings = settleLenses(audits, verifiers, priorFindings);
  codexReview.validateRuleChecks(repo, base, tree, audits.get('rule-checks')!.report);
  const runId = reviewRunId(reviews);
  return { author, base, tree, sinceTree, rootRunId: root || runId, previous, findings };
}

export function sharedAuthor(reviews: Review[]): string {
  let author: string;
  try {
    const parents = new Set<string>();
    for (const review of reviews) {
      const parent = review.meta['source']['subagent']['thread_spawn']['parent_thread_id'];
      if (parent === undefined || parent !== review.meta['parent_thread_id']) throw new RangeError('parent mismatch');
      parents.add(parent);
    }
    if (parents.size !== 1) throw new RangeError('several parents');
    author = [...parents][0]!;
    if (reviews.some((review) => review.identity === author)) throw new RangeError('author reviews itself');
  } catch (error) {
    if (!writers.isInputFailure(error)) throw error;
    throw new writers.Refused('reviewers must be distinct children of the same author');
  }
  codexReview.locateSession(author);
  return author;
}

export function validateReport(report: JsonObject, repo: string, target: Target): void {
  const expectedKeys = reportKeys();
  if (Object.hasOwn(report, writers.NO_TEST_REASON)) expectedKeys.add(writers.NO_TEST_REASON);
  if (!codexReview.hasExactKeys(report, expectedKeys) || report['version'] !== 2 || !['audit', 'verify'].includes(report['role'])) {
    throw new writers.Refused('invalid lens review schema or role');
  }
  if (report['repo'] !== repo || TARGET_FIELDS.some((name, index) => report[name] !== target[index])) {
    throw new writers.Refused('native reviewers disagree about the target');
  }
  for (const name of ['base', 'tree', 'since_tree']) {
    const identity = report[name];
    if (name === 'since_tree' && identity === null) continue;
    if (!env.isSha(identity)) throw new writers.Refused('invalid target object id');
  }
  if ((report['since_tree'] === null) !== (report['root_run_id'] === null)) {
    throw new writers.Refused('delta reviews need both since_tree and root_run_id');
  }
  const root = report['root_run_id'];
  if (root !== null && !env.isRunId(root)) throw new writers.Refused('invalid delta root run id');
  const lenses = report['lenses'];
  if (!isJsonRecord(lenses)) throw new writers.Refused('lenses must be an object');
  const lensNames = Object.keys(lenses);
  if (report['role'] === 'audit') {
    const coversAll = sameMembers(lensNames, codexReview.LENSES);
    if ((lensNames.length !== 1 && !coversAll) || !lensNames.every((name) => codexReview.LENSES.has(name)) || report['audit_session'] !== null) {
      throw new writers.Refused('an auditor covers one lens or the complete required set');
    }
    for (const item of Object.values(lenses)) {
      if (!isJsonRecord(item) || !codexReview.hasExactKeys(item, new Set(['status', 'evidence']))
        || item['status'] !== 'complete' || !codexReview.nonblank(item['evidence'])) {
        throw new writers.Refused('incomplete or unproven review lens');
      }
    }
  } else if (lensNames.length > 0 || typeof report['audit_session'] !== 'string') {
    throw new writers.Refused('verifiers settle findings instead of repeating lens audits');
  }
  if (Object.hasOwn(report, writers.NO_TEST_REASON)
    && (report['role'] !== 'audit' || !lensNames.includes('tests') || !codexReview.nonblank(report[writers.NO_TEST_REASON]))) {
    throw new writers.Refused('no_test_reason must be a nonblank reason from the tests auditor');
  }
  codexReview.validateFindings(report['findings']);
  if (report['role'] === 'audit' && sameMembers(lensNames, codexReview.LENSES)) {
    for (const finding of report['findings']) {
      const [lens, identity] = splitLens(finding['id']);
      if (!lensNames.includes(lens) || identity === null || identity === '') {
        throw new writers.Refused('combined finding ids must start with their lens and a colon');
      }
    }
  }
}

function splitLens(findingId: string): [lens: string, identity: string | null] {
  const colon = findingId.indexOf(':');
  return colon < 0 ? [findingId, null] : [findingId.slice(0, colon), findingId.slice(colon + 1)];
}

export function priorReview(key: string, base: string, sinceTree: string | null, root: string | null, trail: Set<string>,
  previousId: string | null): [JsonObject | null, Record<string, JsonObject[]>] {
  if (sinceTree === null) return [null, Object.fromEntries([...codexReview.LENSES].map((lens) => [lens, []]))];
  const previous = previousId === null
    ? writers.chainHeads(root!).get(key)
    : store.loadReviews(key).find((review) => review.evidence_id === previousId);
  if (!previous || previous.root_run_id !== root || previous.reviewed_tree !== sinceTree || previous.review_base !== base) {
    throw new writers.Refused('delta must follow the exact previous review with the same base');
  }
  if ((previous['source'] ?? {})['version'] !== 2) throw new writers.Refused('lens delta requires an existing version 2 review chain');
  return [previous, validateEvidence(previous, trail).findings];
}

export function settleLenses(audits: Map<string, Review>, verifiers: Map<string, Review>, priorFindings: Record<string, JsonObject[]>): Record<string, JsonObject[]> {
  if (new Set([...audits.values()].map((review) => review.identity)).size === 1) {
    return settleCombined(audits.values().next().value!, verifiers, priorFindings);
  }
  const findings: Record<string, JsonObject[]> = {};
  for (const [lens, review] of audits) {
    const audit = review.report;
    const remaining = codexReview.adjudicatedFindings(priorFindings[lens]!, audit['decisions']);
    if (audit['findings'].length > 0) {
      const verification = verifiers.get(review.identity)!.report;
      remaining.push(...codexReview.adjudicatedFindings(audit['findings'], verification['decisions']));
      remaining.push(...verification['findings']);
    }
    codexReview.validateFindings(remaining);
    findings[lens] = remaining;
  }
  return findings;
}

export function settleCombined(review: Review, verifiers: Map<string, Review>, priorFindings: Record<string, JsonObject[]>): Record<string, JsonObject[]> {
  const audit = review.report;
  const prior = Object.entries(priorFindings).flatMap(([lens, items]) => items.map((finding) => ({ ...finding, id: lens + ':' + finding['id'] })));
  const remaining = codexReview.adjudicatedFindings(prior, audit['decisions']);
  if (audit['findings'].length > 0) {
    const verification = verifiers.get(review.identity)!.report;
    remaining.push(...codexReview.adjudicatedFindings(audit['findings'], verification['decisions']));
    remaining.push(...verification['findings']);
  }
  const findings: Record<string, JsonObject[]> = Object.fromEntries([...codexReview.LENSES].map((lens) => [lens, []]));
  for (const finding of remaining) {
    const [lens, identity] = splitLens(finding['id']);
    if (!Object.hasOwn(findings, lens) || identity === null || identity === '') {
      throw new writers.Refused('combined finding ids must start with their lens and a colon');
    }
    findings[lens]!.push({ ...finding, id: identity });
  }
  for (const items of Object.values(findings)) codexReview.validateFindings(items);
  return findings;
}

export function reviewRunId(reviews: Review[]): string {
  const identities = reviews.map((review) => review.identity).sort(compareCodePoints).join('\n');
  return RUN_ID_PREFIX + codexReview.digest(Buffer.from(identities, 'utf8')).slice(0, RUN_ID_DIGEST_LENGTH);
}

export function buildBody(repo: string, key: string, bundle: Bundle, reviews: Review[]): { [key: string]: any } {
  if (gitcmd.objectType(repo, bundle.base) !== 'commit' || gitcmd.objectType(repo, bundle.tree) !== 'tree') {
    throw new writers.Refused('review target objects do not exist');
  }
  const paths = gitcmd.diffEntries(repo, bundle.sinceTree || bundle.base, bundle.tree)
    .map((entry) => ({ path: entry.path, blob: entry.blob, mode: entry.mode }));
  if (paths.length === 0) throw new writers.Refused('review recognized zero changed paths');
  const findings = Object.values(bundle.findings).flat();
  const verdict = findings.some((finding) => BLOCKING_IMPACTS.includes(finding['impact'])) ? 'NEEDS_FIXES' : 'PASS';
  const runId = reviewRunId(reviews);
  const audits = reviews.filter((review) => review.report['role'] === 'audit').map((review) => review.identity);
  const source = {
    version: 2, via: codexReview.VIA, session_id: bundle.author,
    agent_id: audits.sort(compareCodePoints)[0],
    reviewers: reviews.toSorted((left, right) => compareCodePoints(left.identity, right.identity))
      .map((review) => ({ session_id: review.identity, path: review.path, sha256: review.sha256 })),
  };
  return {
    repo: key, repo_root: repo, run_id: runId, root_run_id: bundle.rootRunId,
    since: bundle.previous ? bundle.previous['evidence_id'] : null,
    since_tree: bundle.sinceTree, review_base: bundle.base, head: null,
    snapshot_tree: bundle.tree, reviewed_tree: bundle.tree, review_kind: codexReview.KIND,
    verdict, paths, source,
    [writers.NO_TEST_REASON]: reviews.find((review) => review.report['role'] === 'audit'
      && Object.hasOwn(review.report['lenses'], 'tests'))!.report[writers.NO_TEST_REASON] ?? null,
  };
}

export function validateEvidence(evidence: JsonObject, trail: Set<string> | null = null): Bundle {
  const seen = new Set(trail ?? []);
  const identity = evidence['evidence_id'];
  if (seen.has(identity)) throw new writers.Refused('cyclic native review chain');
  seen.add(identity);
  const source = evidence['source'] || {};
  if (!codexReview.hasExactKeys(source, SOURCE_KEYS) || source['version'] !== 2 || source['via'] !== codexReview.VIA) {
    throw new writers.Refused('invalid lens review provenance');
  }
  const recorded = source['reviewers'];
  if (!Array.isArray(recorded) || recorded.some((item) => !codexReview.hasExactKeys(item, REVIEWER_KEYS))) {
    throw new writers.Refused('invalid reviewer source list');
  }
  const reviews = loadReviews(recorded.map((item) => item['session_id']));
  const bundle = analyze(evidence['repo_root'], evidence['repo'], reviews, seen, evidence['since'] ?? null);
  const expected = buildBody(evidence['repo_root'], evidence['repo'], bundle, reviews);
  if (Object.entries(expected).some(([name, value]) => !isDeepStrictEqual(evidence[name] ?? null, value))) {
    throw new writers.Refused('native lens evidence differs from its completed reviews or Git target');
  }
  return bundle;
}

function sameMembers(actual: Iterable<string>, expected: Set<string>): boolean {
  const members = new Set(actual);
  return members.size === expected.size && [...members].every((name) => expected.has(name));
}
