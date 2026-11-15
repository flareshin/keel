import { isAbsolute, relative, sep } from 'node:path';
import * as env from './env.ts';
import { SPACE_CHARS } from '../../hooks/lib/hookkit/text.ts';

export const FINDINGS_LOG = 'keel-findings.jsonl';
const NEEDS_FIXES = 'NEEDS_FIXES';
const BLOCKING_HEADING = 'Merge-blocking';
const BLOCK_END = /\n(?:Non-blocking|Pre-existing|Optional|Adjusted|Refuted|KEEL-EVIDENCE)/;
const ITEM_START = /^(?=- \[)/m;
const ITEM_HEAD = /^- \[(high|medium)(?:, [^\]\n]*)?\] ([a-z0-9-]+)\/(\S+?): ([^\n]*)(?:\n {2}At: ([^\n]*?)(?: - [^\n]*)?$)?/m;
export const KEEL_EVIDENCE_LINE = new RegExp(`(?<![^\\n])[${SPACE_CHARS}]*KEEL-EVIDENCE: (\\{[^\\n]*\\})[${SPACE_CHARS}]*(?=\\n|$)`, 'gu');
export const NO_LOCATION = /^N\/A\b/;

export interface BlockingFinding {
  impact: string;
  lens: string;
  findingId: string;
  summary: string;
  text: string;
  file: string | null;
}

export interface LoggedReview {
  evidenceId: string;
  repo: string;
  repoRoot: string;
  claimedRepoRoot: string;
  rootRunId: string;
  runId: string;
}

type OwnedFinding = BlockingFinding & { path: string | null };

export function carriesFindings(verdict: string): boolean {
  return verdict === NEEDS_FIXES;
}

export function blockingFindings(report: string): BlockingFinding[] | null {
  const start = report.indexOf(BLOCKING_HEADING);
  if (start === -1) return null;
  const block = report.slice(start + BLOCKING_HEADING.length).split(BLOCK_END)[0] as string;
  return block.split(ITEM_START).flatMap((item) => {
    const head = ITEM_HEAD.exec(item);
    if (head === null || head.index !== 0) return [];
    const [, impact, lens, findingId, summary, file] = head;
    return [{
      impact: impact as string, lens: lens as string, findingId: findingId as string,
      summary: (summary as string).trim(), text: item, file: locationOf(file),
    }];
  });
}

function locationOf(file: string | undefined): string | null {
  const location = file?.trim() ?? '';
  return location === '' || NO_LOCATION.test(location) ? null : location;
}

export function logBlockingFindings(report: string, review: LoggedReview): number {
  const owned = ownedFindings(report, review);
  const base = {
    ts: env.iso(env.utcNow()), evidence_id: review.evidenceId, repo: review.repo,
    root_run_id: review.rootRunId, run_id: review.runId,
  };
  if (owned === null) {
    env.appendRecord(FINDINGS_LOG, { ...base, unparsed: true });
    return 0;
  }
  env.appendRecords(FINDINGS_LOG, owned.map((finding) => ({
    ...base, impact: finding.impact, lens: finding.lens, finding_id: finding.findingId,
    path: finding.path, summary: finding.summary,
  })));
  return owned.length;
}

function ownedFindings(report: string, review: LoggedReview): OwnedFinding[] | null {
  const findings = blockingFindings(report);
  if (findings === null || findings.length === 0) return null;
  const reportedRoots = reportedRepoRoots(report);
  const ownRoots = [review.claimedRepoRoot, review.repoRoot];
  const owned: OwnedFinding[] = [];
  for (const finding of findings) {
    const owner = finding.file !== null && isAbsolute(finding.file) ? innermostRoot(finding.file, [...reportedRoots, ...ownRoots]) : null;
    if (owner === null) {
      if (reportedRoots.length <= 1) owned.push({ ...finding, path: finding.file });
    } else if (ownRoots.includes(owner)) {
      owned.push({ ...finding, path: relative(owner, finding.file as string) });
    }
  }
  return owned;
}

function reportedRepoRoots(report: string): string[] {
  const roots = new Set<string>();
  for (const [, line] of report.matchAll(KEEL_EVIDENCE_LINE)) {
    const repoRoot = repoRootOf(line as string);
    if (repoRoot !== null) roots.add(repoRoot);
  }
  return [...roots];
}

function repoRootOf(evidenceLine: string): string | null {
  try {
    const claim: unknown = JSON.parse(evidenceLine);
    if (claim === null || typeof claim !== 'object') return null;
    const repoRoot = (claim as Record<string, unknown>)['repo_root'];
    return typeof repoRoot === 'string' ? repoRoot : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function innermostRoot(file: string, roots: string[]): string | null {
  let owner: string | null = null;
  for (const root of roots) {
    if (!file.startsWith(root + sep)) continue;
    if (owner === null || root.length > owner.length) owner = root;
  }
  return owner;
}
