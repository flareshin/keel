import { closeSync, openSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDir, resolveLinks, splitLines } from '../../measure/lib/measurekit/files.ts';
import { DELETED_MODE, GITLINK_MODE } from './env.ts';
import { runCaptured } from './subprocess.ts';
import type { Completed } from './subprocess.ts';
import { decodeStrict, words } from './text.ts';

export const GIT_TIMEOUT_SECONDS = 20;
export const FETCH_TIMEOUT_SECONDS = 20;
export const SNAPSHOT_TIMEOUT_SECONDS = 300;
const DEFAULT_REMOTE = 'origin';
export const GH_RESOLVED_BASE = 'base';
const GH_DEFAULT_REMOTE_KEYS = '^remote\\..*\\.gh-resolved$';
const GH_RESOLVED_SUFFIX = '.gh-resolved';
const REMOTE_PREFIX = 'remote.';
const TEMP_INDEX_RANDOM_BYTES = 6;

export class GitError extends Error {}

export interface PathEntry {
  path: string;
  blob: string | null;
  mode: string;
  oldMode: string;
  oldBlob: string | null;
}

export interface PathStat {
  added: number;
  deleted: number;
}

export interface GhDefault {
  remote: string;
  resolved: string;
}

export interface GitOptions {
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
}

export function isDeleted(entry: PathEntry): boolean {
  return entry.blob === null;
}

export function isGitlink(entry: PathEntry): boolean {
  return entry.mode === GITLINK_MODE || (isDeleted(entry) && entry.oldMode === GITLINK_MODE);
}

export function run(repo: string, args: string[], options: GitOptions = {}): Completed {
  const completed = runCaptured(['git', '-C', repo, ...args],
    { env: options.env, timeoutSeconds: options.timeoutSeconds ?? GIT_TIMEOUT_SECONDS });
  if ((options.check ?? true) && completed.returncode !== 0) {
    throw new GitError(`git ${args.join(' ')}: ${completed.stderr.toString().trim()}`);
  }
  return completed;
}

export function text(repo: string, args: string[], options: GitOptions = {}): string {
  return run(repo, args, options).stdout.toString().trim();
}

function outputIfOk(repo: string, args: string[]): string | null {
  const completed = run(repo, args, { check: false });
  if (completed.returncode !== 0) return null;
  return completed.stdout.toString().trim() || null;
}

export function toplevel(path: string): string | null {
  const root = isDir(path) ? outputIfOk(path, ['rev-parse', '--show-toplevel']) : null;
  return root ? resolveLinks(root) : null;
}

export function originUrl(repo: string): string | null {
  return remoteUrl(repo, DEFAULT_REMOTE);
}

export function remoteUrl(repo: string, remote: string): string | null {
  return outputIfOk(repo, ['remote', 'get-url', remote]);
}

export function pushUrls(repo: string, remote: string): string[] {
  return splitLines(outputIfOk(repo, ['remote', 'get-url', '--push', '--all', remote]) ?? '');
}

export function remotes(repo: string): string[] {
  return words(outputIfOk(repo, ['remote']) ?? '');
}

export function pushRemote(repo: string): string {
  const branch = currentBranch(repo);
  const keys = branch === null ? ['remote.pushDefault']
    : [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`];
  for (const key of keys) {
    const configured = outputIfOk(repo, ['config', '--get', key]);
    if (configured) return configured;
  }
  return DEFAULT_REMOTE;
}

export function ghDefaultRemote(repo: string): GhDefault | null {
  const listed = outputIfOk(repo, ['config', '--get-regexp', GH_DEFAULT_REMOTE_KEYS]);
  if (listed === null) return null;
  const firstLine = splitLines(listed)[0]!;
  const separator = firstLine.indexOf(' ');
  const key = separator < 0 ? firstLine : firstLine.slice(0, separator);
  const value = separator < 0 ? '' : firstLine.slice(separator + 1);
  return { remote: key.slice(REMOTE_PREFIX.length, key.length - GH_RESOLVED_SUFFIX.length), resolved: value };
}

export function commitSha(repo: string, rev: string): string | null {
  return outputIfOk(repo, ['rev-parse', '--verify', '-q', rev + '^{commit}']);
}

export function treeOfCommit(repo: string, sha: string): string {
  return text(repo, ['rev-parse', '--verify', sha + '^{tree}']);
}

export function objectType(repo: string, sha: string): string | null {
  return outputIfOk(repo, ['cat-file', '-t', sha]);
}

export function refExists(repo: string, fullRef: string): boolean {
  return run(repo, ['show-ref', '--verify', '-q', fullRef], { check: false }).returncode === 0;
}

export function currentBranch(repo: string): string | null {
  return outputIfOk(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
}

export function mergeBase(repo: string, left: string, right: string): string | null {
  return outputIfOk(repo, ['merge-base', left, right]);
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  const completed = run(repo, ['merge-base', '--is-ancestor', ancestor, descendant], { check: false });
  if (completed.returncode !== 0 && completed.returncode !== 1) {
    throw new GitError(`merge-base --is-ancestor ${ancestor} ${descendant}: ${completed.stderr.toString()}`);
  }
  return completed.returncode === 0;
}

export function firstParentAncestors(repo: string, head: string, stop: string): string[] {
  const line = words(text(repo, ['rev-list', '--first-parent', head + '^', '^' + stop]));
  const last = line.length > 0 ? line.at(-1)! : head;
  if (commitSha(repo, last + '^') !== stop) return [];
  return [...line, stop];
}

export function lastCommitTouching(repo: string, base: string, head: string, path: string): string {
  return text(repo, ['log', '-1', '--format=%H', `${base}..${head}`, '--', path]);
}

export function fetch(repo: string, args: string[]): void {
  run(repo, ['fetch', '--quiet', ...args], { timeoutSeconds: FETCH_TIMEOUT_SECONDS });
}

export function diffEntries(repo: string, oldTree: string, newTree: string): PathEntry[] {
  const fields = splitOnNul(run(repo, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev',
    '--ignore-submodules=none', oldTree, newTree]).stdout);
  const entries: PathEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!;
    if (meta[0] !== 0x3a) continue;
    const [oldMode, newMode, oldSha, newSha, status] = splitLimit(meta.subarray(1).toString(), ' ', 4) as [string, string, string, string, string];
    const deleted = status.startsWith('D');
    entries.push({
      path: decodeStrict(fields[index + 1]!, 'a path in the git diff'),
      blob: deleted ? null : newSha,
      mode: deleted ? DELETED_MODE : newMode,
      oldMode,
      oldBlob: oldMode === DELETED_MODE ? null : oldSha,
    });
  }
  return entries;
}

export function diffStats(repo: string, oldTree: string, newTree: string): Map<string, PathStat> {
  const raw = run(repo, ['diff-tree', '-r', '--numstat', '-z', '--no-renames', '--ignore-submodules=none',
    oldTree, newTree]).stdout;
  const stats = new Map<string, PathStat>();
  for (const record of splitOnNul(raw).filter((item) => item.length > 0)) {
    const [added, deleted, path] = splitLimit(decodeStrict(record, 'a path in the git diff'), '\t', 2) as [string, string, string];
    const binary = added === '-';
    stats.set(path, { added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted) });
  }
  return stats;
}

export function treeEntry(repo: string, tree: string, path: string): [mode: string, object: string] | null {
  const record = splitOnNul(run(repo, ['ls-tree', '-z', tree, '--', path]).stdout)[0]!;
  if (record.length === 0) return null;
  const [mode, , rest] = splitLimit(decodeStrict(record, 'a path in the git tree'), ' ', 2) as [string, string, string];
  return [mode, rest.split('\t', 1)[0]!];
}

export function submoduleRoots(repo: string): string[] {
  const listed = text(repo, ['submodule', 'foreach', '--quiet', '--recursive', 'pwd']);
  return splitLines(listed).map((root) => resolveLinks(root));
}

export function snapshotTree(repo: string): string {
  const index = join(tmpdir(), 'keel-index-' + randomBytes(TEMP_INDEX_RANDOM_BYTES).toString('hex'));
  closeSync(openSync(index, 'wx'));
  unlinkSync(index);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const options = { env, timeoutSeconds: SNAPSHOT_TIMEOUT_SECONDS };
  try {
    run(repo, ['--work-tree', repo, 'read-tree', 'HEAD'], options);
    run(repo, ['--work-tree', repo, 'add', '-A'], options);
    return text(repo, ['--work-tree', repo, 'write-tree'], options);
  } finally {
    if (existsSync(index)) unlinkSync(index);
  }
}

function splitOnNul(bytes: Buffer): Buffer[] {
  const pieces: Buffer[] = [];
  let start = 0;
  for (let index = bytes.indexOf(0); index >= 0; index = bytes.indexOf(0, start)) {
    pieces.push(bytes.subarray(start, index));
    start = index + 1;
  }
  pieces.push(bytes.subarray(start));
  return pieces;
}

function splitLimit(value: string, separator: string, maxSplits: number): string[] {
  const pieces: string[] = [];
  let rest = value;
  while (pieces.length < maxSplits) {
    const at = rest.indexOf(separator);
    if (at < 0) break;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  pieces.push(rest);
  return pieces;
}
