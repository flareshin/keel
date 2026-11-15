import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { isBlankEitherWay } from './text.ts';
import { decodeStrict, isSystemError, resolveLinks, splitLines } from '../../measure/lib/measurekit/files.ts';
import { compareCodePoints, parseJsonKeepingIntegers } from '../../measure/lib/measurekit/json.ts';
import * as codexLenses from './codex_lenses.ts';
import * as env from './env.ts';
import { TimeoutExpired } from '../../measure/lib/measurekit/timeout.ts';
import { runCaptured } from './subprocess.ts';
import * as writers from './writers.ts';
import { isJsonRecord } from './writers.ts';
import type { JsonObject } from './writers.ts';

export const KIND = 'codex-lens-review';
export const VIA = 'CodexSubagents';
export const LENSES = new Set(['reuse', 'contract', 'tests', 'writing-readable-code', 'rule-checks']);
export const REPORT_KEYS = new Set(['version', 'role', 'repo', 'base', 'tree', 'lenses', 'findings', 'audit_session', 'decisions']);
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
  if (source['version'] !== 2) throw new writers.Refused('Codex review evidence must be version 2');
  codexLenses.validateEvidence(evidence);
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
  return typeof value === 'string' && !isBlankEitherWay(value);
}

export function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function runRuleChecks(repo: string, base: string, tree: string): string {
  const script = join(env.keelHome(), 'skills/writing-readable-code/scripts/rule-checks.ts');
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
