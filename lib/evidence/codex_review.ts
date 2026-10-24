import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { decodeStrict, isSystemError, resolveLinks, splitLines } from '../../measure/lib/measurekit/files.ts';
import { compareCodePoints, parseJsonKeepingIntegers } from '../../measure/lib/measurekit/json.ts';
import * as codexLenses from './codex_lenses.ts';
import * as env from './env.ts';
import { TimeoutExpired, runCaptured } from './subprocess.ts';
import * as writers from './writers.ts';
import { isJsonRecord } from './writers.ts';
import type { JsonObject } from './writers.ts';

export const KIND = 'codex-lens-review';
export const VIA = 'CodexSubagents';
export const LENSES = new Set(['reuse', 'contract', 'tests', 'readable-code', 'rule-checks']);
export const REPORT_KEYS = new Set(['version', 'role', 'repo', 'base', 'tree', 'lenses', 'findings', 'audit_session', 'decisions']);
const SOURCE_KEYS = new Set(['via', 'session_id', 'audit_id', 'agent_id', 'audit_path', 'agent_transcript_path', 'audit_sha256', 'agent_sha256']);
const LENS_ITEM_KEYS = new Set(['status', 'evidence']);
const DECISION_KEYS = new Set(['id', 'verdict', 'evidence']);
const FINDING_KEYS = new Set(['id', 'impact', 'evidence', 'scenario']);
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RULE_CHECKS_TIMEOUT_SECONDS = 120;
const SUMMARY_FIELDS = 'repos=[0-9]+ scanned_lines=[0-9]+ signals=[0-9]+ unscanned=\\S+ blocked=\\S+';
const SUMMARY_LINE = /^summary repos=([0-9]+) scanned_lines=([0-9]+) signals=([0-9]+) unscanned=(\S+) blocked=(\S+)$/u;
const CITED_SUMMARY = new RegExp(`summary ${SUMMARY_FIELDS}`, 'gu');
const SUMMARY_PREFIX = 'summary ';

export const seams = { sessionRoot };

export function validateEvidence(evidence: JsonObject): void {
  const source = evidence['source'] || {};
  if (source['version'] === 2) {
    codexLenses.validateEvidence(evidence);
    return;
  }
  if (!hasExactKeys(source, SOURCE_KEYS) || source['via'] !== VIA || evidence['review_kind'] !== KIND) {
    throw new writers.Refused('invalid Codex review provenance');
  }
  const [auditPath, auditBytes] = locateSession(source['audit_id']);
  const [verifierPath, verifierBytes] = locateSession(source['agent_id']);
  const located = [auditPath, verifierPath, digest(auditBytes), digest(verifierBytes)];
  const recorded = [source['audit_path'], source['agent_transcript_path'], source['audit_sha256'], source['agent_sha256']];
  if (located.some((value, index) => value !== recorded[index])) throw new writers.Refused('Codex review transcript changed or moved');
  const [auditMeta, audit] = completedReport(auditBytes, source['audit_id']);
  const [verifierMeta, verification] = completedReport(verifierBytes, source['agent_id']);
  const author = sharedAuthor(auditMeta, verifierMeta, source['audit_id'], source['agent_id']);
  if (author !== source['session_id']) throw new writers.Refused('Codex author identity changed');
  locateSession(author);
  const verdict = validateReports(audit, verification, evidence['repo_root'], source['audit_id']);
  validateRuleChecks(evidence['repo_root'], audit['base'], audit['tree'], audit, verification);
  const root = 'cx-' + source['agent_id'];
  const actual = ['review_base', 'reviewed_tree', 'snapshot_tree', 'verdict', 'run_id', 'root_run_id', 'head', 'since', 'since_tree',
    writers.NO_TEST_REASON].map((key) => evidence[key] ?? null);
  const expected = [audit['base'], audit['tree'], audit['tree'], verdict, root, root, null, null, null, null];
  if (actual.some((value, index) => value !== expected[index])) {
    throw new writers.Refused('Codex evidence does not match its completed reviews');
  }
}

export function locateSession(identity: unknown): [path: string, content: Buffer] {
  if (typeof identity !== 'string' || !CANONICAL_UUID.test(identity)) {
    throw new writers.Refused('Codex session id must be a canonical UUID');
  }
  const root = seams.sessionRoot();
  const sessions = join(root, 'sessions');
  const matches = findRollouts(sessions, identity);
  if (matches.length !== 1) throw new writers.Refused('expected one live Codex rollout for ' + identity);
  const path = matches[0]!;
  if (lstatSync(path).isSymbolicLink() || !resolveLinks(path).startsWith(sessions + sep)) {
    throw new writers.Refused('Codex rollout escaped its session root');
  }
  let content: Buffer;
  try {
    content = readFileSync(path);
    const records = splitLines(decodeStrict(content, path)).map((line) => parseJsonKeepingIntegers(line) as JsonObject);
    if (records.length === 0 || records[0]!['type'] !== 'session_meta' || asObject(records[0]!['payload'])['id'] !== identity) {
      throw new TypeError('not a session');
    }
  } catch (error) {
    if (!writers.isInputFailure(error)) throw error;
    throw new writers.Refused('invalid Codex rollout: ' + path);
  }
  return [resolveLinks(path), content];
}

function findRollouts(directory: string, identity: string): string[] {
  const suffix = `-${identity}.jsonl`;
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (!isSystemError(error)) throw error;
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix) && entry.name.length >= 'rollout-'.length + suffix.length) {
      found.push(path);
    }
    if (entry.isDirectory()) found.push(...findRollouts(path, identity));
  }
  return found;
}

export function sessionRoot(): string {
  return resolveLinks(join(userInfo().homedir, '.codex'));
}

export function completedReport(content: Buffer, identity: string): [meta: JsonObject, report: JsonObject] {
  try {
    const records = splitLines(decodeStrict(content, 'the Codex rollout')).map((line) => asObject(parseJsonKeepingIntegers(line)));
    const meta = asObject(required(records[0], 'payload'));
    if (required(records[0], 'type') !== 'session_meta' || required(meta, 'id') !== identity) throw new RangeError('not this session');
    let turn: any = null;
    let final: string | null = null;
    let complete = false;
    for (const record of records.slice(1)) {
      const payload = asObject(record['payload'] || {});
      if (record['type'] === 'event_msg' && payload['type'] === 'task_started') {
        turn = payload['turn_id'] ?? null;
        final = null;
        complete = false;
      }
      if (record['type'] === 'response_item' && payload['type'] === 'message' && payload['role'] === 'assistant' && payload['phase'] === 'final_answer') {
        final = joinOutputText(required(payload, 'content'));
      }
      if (record['type'] === 'event_msg' && (payload['type'] === 'task_complete' || payload['type'] === 'turn_aborted')) {
        complete = payload['type'] === 'task_complete' && typeof turn === 'string' && turn !== '' && payload['turn_id'] === turn;
      }
    }
    if (!complete || final === null) throw new RangeError('no completed report');
    const report = parseJsonKeepingIntegers(final);
    if (!isJsonRecord(report)) throw new RangeError('report is not an object');
    return [meta, report as JsonObject];
  } catch (error) {
    if (!writers.isInputFailure(error)) throw error;
    throw new writers.Refused('Codex reviewer has no completed structured final report');
  }
}

function joinOutputText(content: unknown): string {
  if (!Array.isArray(content)) throw new TypeError('content is not a list');
  return content.filter((item) => asObject(item)['type'] === 'output_text').map((item) => {
    const text = required(item, 'text');
    if (typeof text !== 'string') throw new TypeError('text is not a string');
    return text;
  }).join('');
}

export function sharedAuthor(audit: JsonObject, verifier: JsonObject, auditId: string, verifierId: string): string {
  try {
    const parents: string[] = [];
    for (const meta of [audit, verifier]) {
      const parent = required(required(required(required(meta, 'source'), 'subagent'), 'thread_spawn'), 'parent_thread_id');
      if (parent !== required(meta, 'parent_thread_id')) throw new RangeError('parent mismatch');
      parents.push(parent);
    }
    if (parents[0] !== parents[1] || new Set([parents[0], auditId, verifierId]).size !== 3) throw new RangeError('not distinct');
    return parents[0]!;
  } catch (error) {
    if (!writers.isInputFailure(error)) throw error;
    throw new writers.Refused('audit and verifier must be distinct children of the same author');
  }
}

export function validateReports(audit: JsonObject, verification: JsonObject, repo: string, auditId: string): string {
  for (const [report, role] of [[audit, 'audit'], [verification, 'verify']] as const) {
    if (!hasExactKeys(report, REPORT_KEYS) || report['version'] !== 1 || report['role'] !== role) {
      throw new writers.Refused('invalid native review report schema or role');
    }
    if (report['repo'] !== repo || report['base'] !== audit['base'] || report['tree'] !== audit['tree']) {
      throw new writers.Refused('native reviewers disagree about the target');
    }
    for (const key of ['base', 'tree']) {
      if (!env.isSha(report[key])) throw new writers.Refused('invalid target object id');
    }
    const lenses = report['lenses'];
    if (!isJsonRecord(lenses) || !hasExactKeys(lenses, LENSES)) throw new writers.Refused('every native review must cover all five lenses');
    if (Object.values(lenses).some((item) => !isCompleteLens(item))) throw new writers.Refused('incomplete or unproven review lens');
    validateFindings(report['findings']);
  }
  if (audit['audit_session'] !== null || !isEmptyList(audit['decisions']) || verification['audit_session'] !== auditId) {
    throw new writers.Refused('invalid audit linkage');
  }
  const findings = [...adjudicatedFindings(audit['findings'], verification['decisions']), ...verification['findings']];
  return findings.some((finding) => finding['impact'] === 'high' || finding['impact'] === 'medium') ? 'NEEDS_FIXES' : 'PASS';
}

export function adjudicatedFindings(findings: JsonObject[], decisions: unknown): JsonObject[] {
  if (!Array.isArray(decisions)) throw new writers.Refused('verifier decisions must be a list');
  const seen: unknown[] = [];
  const confirmed: unknown[] = [];
  for (const decision of decisions) {
    if (!isJsonRecord(decision) || !hasExactKeys(decision, DECISION_KEYS)
      || (decision['verdict'] !== 'confirmed' && decision['verdict'] !== 'refuted') || !nonblank(decision['evidence'])) {
      throw new writers.Refused('every finding needs an evidenced verifier decision');
    }
    seen.push(decision['id']);
    if (decision['verdict'] === 'confirmed') confirmed.push(decision['id']);
  }
  const ids = findings.map((finding) => finding['id']);
  if (!sameMultiset(seen, ids)) throw new writers.Refused('verifier must settle every audit finding exactly once');
  return findings.filter((finding) => confirmed.includes(finding['id']));
}

export function validateFindings(findings: unknown): void {
  if (!Array.isArray(findings)) throw new writers.Refused('findings must be a list');
  const ids: unknown[] = [];
  for (const finding of findings) {
    if (!isJsonRecord(finding) || !hasExactKeys(finding, FINDING_KEYS)) throw new writers.Refused('invalid finding schema');
    if (!['high', 'medium', 'low'].includes(finding['impact']) || ['id', 'evidence', 'scenario'].some((key) => !nonblank(finding[key]))) {
      throw new writers.Refused('finding needs impact, file evidence and a failure scenario');
    }
    ids.push(finding['id']);
  }
  if (ids.length !== new Set(ids).size) throw new writers.Refused('finding ids must be unique');
}

export function nonblank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function runRuleChecks(repo: string, base: string, tree: string): string {
  const keelHome = resolve(dirname(realpathSync(import.meta.filename)), '..', '..');
  const script = join(keelHome, 'skills/readable-code/scripts/rule-checks.ts');
  let stdout: string;
  let returncode: number;
  try {
    const completed = runCaptured([process.execPath, script, '--repo', repo, '--base', base, '--head', tree],
      { timeoutSeconds: RULE_CHECKS_TIMEOUT_SECONDS });
    returncode = completed.returncode;
    stdout = decodeStrict(completed.stdout, 'rule-checks output');
  } catch (error) {
    if (isSystemError(error) || error instanceof TimeoutExpired) {
      throw new writers.Refused('rule-checks could not complete: ' + error.message);
    }
    throw error;
  }
  const lines = splitLines(stdout);
  const summaries = lines.flatMap((line) => {
    const match = SUMMARY_LINE.exec(line);
    return match === null ? [] : [match.slice(1, 6)];
  });
  if (returncode || summaries.length !== 1 || Number(summaries[0]![0]) === 0 || summaries[0]![3] !== 'none' || summaries[0]![4] !== 'none') {
    throw new writers.Refused('rule-checks failed, recognized zero repos or left targets unscanned');
  }
  return lines.find((line) => line.startsWith(SUMMARY_PREFIX))!;
}

export function validateRuleChecks(repo: string, base: string, tree: string, audit: JsonObject, verification: JsonObject | null = null): void {
  const measured = runRuleChecks(repo, base, tree);
  const reports = verification !== null ? [audit, verification] : [audit];
  for (const report of reports) {
    const cited = report['lenses']['rule-checks']['evidence'].match(CITED_SUMMARY) ?? [];
    if (cited.length !== 1 || cited[0] !== measured) {
      throw new writers.Refused('each reviewer must cite the exact rule-checks summary for the reviewed target');
    }
  }
}

export function hasExactKeys(value: unknown, keys: Set<string>): boolean {
  if (!isJsonRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isCompleteLens(item: unknown): boolean {
  return isJsonRecord(item) && hasExactKeys(item, LENS_ITEM_KEYS) && item['status'] === 'complete' && nonblank(item['evidence']);
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function sameMultiset(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length || [...left, ...right].some((item) => typeof item !== 'string')) return false;
  const sortedLeft = (left as string[]).toSorted(compareCodePoints);
  const sortedRight = (right as string[]).toSorted(compareCodePoints);
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function asObject(value: unknown): JsonObject {
  if (!isJsonRecord(value)) throw new TypeError('not an object');
  return value;
}

function required(value: unknown, key: string): any {
  const object = asObject(value);
  if (!Object.hasOwn(object, key)) throw new RangeError('missing key ' + key);
  return object[key];
}
