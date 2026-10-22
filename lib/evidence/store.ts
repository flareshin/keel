import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as env from './env.ts';
import { compareCodePoints, decodeStrict, isDirectory, isJsonObject, pyOsErrorMessage, pythonJsonDumps, pythonJsonLoads, sortedStrings, universalNewlines } from './pycompat.ts';
import type { JsonValue } from './pycompat.ts';

export const REPO_SCOPED_KINDS = ['review', 'tests', 'smoke'];
export const GLOBAL_KINDS = ['approval', 'ack'];
const SCHEMA = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const TEMP_FILE_RANDOM_BYTES = 6;

export class EvidenceError extends Error {}

export interface Evidence {
  schema: number;
  kind: string;
  evidence_id: string;
  created_at: string;
  expires_at: string;
  [key: string]: any;
}

export interface ReviewedEntry {
  path: string;
  blob: string | null;
  mode: string;
}

export interface ReviewEvidence extends Evidence {
  repo: string;
  repo_root: string;
  run_id: string;
  root_run_id: string;
  since: string | null;
  since_tree: string | null;
  review_base: string;
  head: string | null;
  snapshot_tree: string | null;
  reviewed_tree: string;
  review_kind: string;
  verdict: string;
  paths: ReviewedEntry[];
  source: { [key: string]: any };
}

export function evidenceRoot(): string {
  return join(env.stateDir(), 'evidence');
}

export function kindDir(kind: string, repoKey: string | null = null): string {
  if (!REPO_SCOPED_KINDS.includes(kind)) return join(evidenceRoot(), kind);
  if (!repoKey) throw new RangeError(`${kind} evidence is scoped to a repo`);
  return join(evidenceRoot(), kind, repoKey.replaceAll('/', '__'));
}

export function write(kind: string, body: { [key: string]: JsonValue }, repoKey: string | null = null): Evidence {
  const now = env.utcNow();
  const evidence: Evidence = {
    schema: SCHEMA,
    kind,
    evidence_id: env.newId(kind, now, env.EVIDENCE_ID_RANDOM_BYTES),
    created_at: env.iso(now),
    expires_at: env.iso(new Date(now.getTime() + env.EVIDENCE_TTL_MS)),
    ...body,
  };
  const directory = kindDir(kind, repoKey);
  ensurePrivateDirs(directory);
  const final = join(directory, evidence.evidence_id + '.json');
  const tempPath = join(directory, '.tmp-' + randomBytes(TEMP_FILE_RANDOM_BYTES).toString('hex'));
  try {
    writeFileSync(tempPath, pythonJsonDumps(evidence, { sortKeys: true }) + '\n', { flag: 'wx', mode: FILE_MODE });
    chmodSync(tempPath, FILE_MODE);
    renameSync(tempPath, final);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
  return evidence;
}

export function load(kind: string, repoKey: string | null = null): Evidence[] {
  const now = env.iso(env.utcNow());
  const live = listFiles(kind, repoKey).map(readFile).filter((evidence) => compareCodePoints(evidence.expires_at, now) >= 0);
  return live.sort((left, right) =>
    compareCodePoints(left.created_at, right.created_at) || compareCodePoints(left.evidence_id, right.evidence_id));
}

export function loadReviews(repoKey: string): ReviewEvidence[] {
  return load('review', repoKey) as ReviewEvidence[];
}

export function listFiles(kind: string, repoKey: string | null = null): string[] {
  const directory = kindDir(kind, repoKey);
  if (!isDirectory(directory)) return [];
  return sortedStrings(readdirSync(directory))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => join(directory, name));
}

export function repoKeys(kind: string): string[] {
  const directory = join(evidenceRoot(), kind);
  if (!isDirectory(directory)) return [];
  return sortedStrings(readdirSync(directory).filter((name) => isDirectory(join(directory, name)))
    .map((name) => name.replace('__', '/')));
}

export function readFile(path: string): Evidence {
  let evidence: unknown;
  try {
    evidence = pythonJsonLoads(universalNewlines(decodeStrict(readFileSync(path))));
  } catch (error) {
    throw new EvidenceError(`unreadable evidence ${path}: ${readFailure(error)}`);
  }
  if (!isJsonObject(evidence) || typeof evidence['expires_at'] !== 'string') {
    throw new EvidenceError('not an evidence object: ' + path);
  }
  return evidence as Evidence;
}

function readFailure(error: unknown): string {
  if (error instanceof Error && 'errno' in error) return pyOsErrorMessage(error as NodeJS.ErrnoException);
  return error instanceof Error ? error.message : String(error);
}

function ensurePrivateDirs(directory: string): void {
  const root = evidenceRoot();
  mkdirSync(dirname(directory), { recursive: true });
  try {
    mkdirSync(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let current = directory;
  for (;;) {
    chmodSync(current, DIRECTORY_MODE);
    if (current === root || current.length <= root.length) break;
    current = dirname(current);
  }
}
