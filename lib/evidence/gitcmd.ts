import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { decodeStrict, InvalidUtf8Error, isDir, resolveLinks } from '../../measure/lib/measurekit/files.ts';
import { DELETED_MODE, GITLINK_MODE } from './env.ts';
import { runCaptured } from './subprocess.ts';
import { stripEitherWay } from './text.ts';
import type { Completed } from './subprocess.ts';

export const LOCAL_GIT_TIMEOUT_SECONDS = 20;
export const FETCH_TIMEOUT_SECONDS = 20;
export const SNAPSHOT_TIMEOUT_SECONDS = 300;
export const DEFAULT_REMOTE = 'origin';
const CONFIG_KEY_MISSING = 1;
const GIT_TRUE = 'true';
export const GH_RESOLVED_BASE = 'base';
const GH_DEFAULT_REMOTE_KEYS = '^remote\\..*\\.gh-resolved$';
const GH_RESOLVED_SUFFIX = '.gh-resolved';
const REMOTE_PREFIX = 'remote.';
const REMOTE_KEYS = '^remote\\.';
const VALUELESS_KEY_MEANS = 'true';
const REMOTE_URL_KEY = /\.(url|pushurl)$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SCP_LIKE = /^[^/]*:/;
const HOME_PREFIX = '~';
const TEMP_INDEX_RANDOM_BYTES = 6;
const OTHER_LINE_BREAK = /[\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const OBJECT_ID = /^[0-9a-f]{40}$/;
const SIZED_OBJECT = /^([0-9a-f]{40}) (\d+)$/;
const PLAIN_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/;
const MIN_PAIRS_WORTH_ONE_QUERY = 2;
const COMMIT_OBJECT_TYPE = 'commit';
const SNAPSHOT_COMMIT_MESSAGE = 'keel precheck snapshot';
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'keel precheck',
  GIT_AUTHOR_EMAIL: 'precheck@keel.invalid',
  GIT_COMMITTER_NAME: 'keel precheck',
  GIT_COMMITTER_EMAIL: 'precheck@keel.invalid',
};

type TreeEntry = [mode: string, object: string];

export interface SizedObject {
  id: string;
  size: number;
}

const treeListings = new Map<string, Map<string, TreeEntry>>();
const ancestryAnswers = new Map<string, boolean>();
const commitObjects = new Map<string, boolean>();

export class GitError extends Error {
  override name = 'GitError';
}

export class MissingCommit extends GitError {
  readonly commit: string;

  constructor(message: string, commit: string) {
    super(message);
    this.commit = commit;
  }
}

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
  env?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  input?: string;
}

export function isDeleted(entry: PathEntry): boolean {
  return entry.blob === null;
}

export function isGitlink(entry: PathEntry): boolean {
  return entry.mode === GITLINK_MODE || (isDeleted(entry) && entry.oldMode === GITLINK_MODE);
}

export function runUnchecked(repo: string, args: string[], options: GitOptions = {}): Completed {
  return runCaptured(['git', '-C', repo, ...args],
    { env: options.env, input: options.input, timeoutSeconds: options.timeoutSeconds ?? LOCAL_GIT_TIMEOUT_SECONDS });
}

export function runOrThrow(repo: string, args: string[], options: GitOptions = {}): Completed {
  const completed = runUnchecked(repo, args, options);
  if (completed.returncode !== 0) {
    throw new GitError(`git ${args.join(' ')}: ${stripEitherWay(completed.stderr.toString())}`);
  }
  return completed;
}

export function textOrThrow(repo: string, args: string[], options: GitOptions = {}): string {
  return withoutFinalNewline(runOrThrow(repo, args, options).stdout.toString());
}

function withoutFinalNewline(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function exactOutputOrNull(repo: string, args: string[]): string | null {
  const completed = runUnchecked(repo, args);
  if (completed.returncode !== 0) return null;
  return withoutFinalNewline(completed.stdout.toString()) || null;
}

function outputOrNull(repo: string, args: string[], options: GitOptions = {}): string | null {
  const lines = linesOrEmpty(repo, args, options);
  if (lines.length > 1) throw new GitError(`git ${args.join(' ')}: the output holds more than one line`);
  return lines[0] ?? null;
}

function linesOrEmpty(repo: string, args: string[], options: GitOptions = {}): string[] {
  const completed = runUnchecked(repo, args, options);
  return completed.returncode === 0 ? gateLines(args, completed.stdout.toString()) : [];
}

export function gateLines(args: string[], output: string): string[] {
  if (output === '') return [];
  const lines = withoutFinalNewline(output).split('\n');
  refuseOtherLineBreaks(args, lines);
  if (lines.includes('')) throw new GitError(`git ${args.join(' ')}: the output holds an empty line`);
  return lines;
}

function refuseOtherLineBreaks(args: string[], pieces: string[]): void {
  const broken = pieces.find((piece) => OTHER_LINE_BREAK.test(piece));
  if (broken !== undefined) {
    throw new GitError(`git ${args.join(' ')}: the output holds a line break other than \\n: ${JSON.stringify(broken)}`);
  }
}

export function toplevel(path: string): string | null {
  const root = isDir(path) ? exactOutputOrNull(path, ['rev-parse', '--show-toplevel']) : null;
  return root ? resolveLinks(root) : null;
}

export function originUrl(repo: string): string | null {
  return remoteUrl(repo, DEFAULT_REMOTE);
}

export function remoteUrl(repo: string, remote: string): string | null {
  return outputOrNull(repo, ['remote', 'get-url', remote]);
}

export function pushUrls(repo: string, remote: string): string[] {
  return linesOrEmpty(repo, ['remote', 'get-url', '--push', '--all', remote]);
}

export function remotes(repo: string): string[] {
  return linesOrEmpty(repo, ['remote']);
}

export interface ConfigView {
  configArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export type MirrorSetting = 'mirror' | 'notMirror' | 'unreadable';

const STORED_CONFIG: ConfigView = { configArgs: [] };

export function pushRemote(repo: string, view: ConfigView = STORED_CONFIG): string {
  const branch = currentBranch(repo);
  const keys = branch === null ? ['remote.pushDefault']
    : [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`];
  for (const key of keys) {
    const configured = outputOrNull(repo, configCommand(view, ['--get', key]), { env: view.env });
    if (configured) return configured;
  }
  return DEFAULT_REMOTE;
}

export function storedConfig(repo: string, keyArgs: readonly string[]): string | null {
  const args = ['config', '--get', ...keyArgs];
  const read = runUnchecked(repo, args);
  if (read.returncode === CONFIG_KEY_MISSING) return null;
  if (read.returncode !== 0) throw new GitError(`git ${args.join(' ')}: ${stripEitherWay(read.stderr.toString())}`);
  return read.stdout.toString().trim();
}

export function pushRemoteMirror(repo: string, remote: string | null, view: ConfigView = STORED_CONFIG): MirrorSetting {
  const name = remote || pushRemote(repo, view);
  const read = runUnchecked(repo, configCommand(view, ['--type=bool', '--get', `remote.${name}.mirror`]), { env: view.env });
  if (read.returncode === CONFIG_KEY_MISSING) return 'notMirror';
  if (read.returncode !== 0) return 'unreadable';
  return read.stdout.toString().trim() === GIT_TRUE ? 'mirror' : 'notMirror';
}

function configCommand(view: ConfigView, args: string[]): string[] {
  return [...view.configArgs, 'config', ...args];
}

export function ghDefaultRemote(repo: string): GhDefault | null {
  const listed = linesOrEmpty(repo, ['config', '--get-regexp', GH_DEFAULT_REMOTE_KEYS]);
  if (listed.length === 0) return null;
  const firstLine = listed[0]!;
  const separator = firstLine.indexOf(' ');
  const key = separator < 0 ? firstLine : firstLine.slice(0, separator);
  const value = separator < 0 ? '' : firstLine.slice(separator + 1);
  return { remote: key.slice(REMOTE_PREFIX.length, key.length - GH_RESOLVED_SUFFIX.length), resolved: value };
}

export function commitSha(repo: string, rev: string): string | null {
  return outputOrNull(repo, ['rev-parse', '--verify', '-q', rev + '^{commit}']);
}

export function treeOfCommit(repo: string, sha: string): string {
  return textOrThrow(repo, ['rev-parse', '--verify', sha + '^{tree}']);
}

export function objectType(repo: string, sha: string): string | null {
  return outputOrNull(repo, ['cat-file', '-t', sha]);
}

export function refExists(repo: string, fullRef: string): boolean {
  return runUnchecked(repo, ['show-ref', '--verify', '-q', fullRef]).returncode === 0;
}

export function currentBranch(repo: string): string | null {
  return outputOrNull(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
}

export function mergeBase(repo: string, left: string, right: string): string | null {
  return outputOrNull(repo, ['merge-base', left, right]);
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  const key = ancestryKey(repo, ancestor, descendant);
  const known = ancestryAnswers.get(key);
  if (known !== undefined) return known;
  const completed = runUnchecked(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (completed.returncode !== 0 && completed.returncode !== 1) {
    const message = `merge-base --is-ancestor ${ancestor} ${descendant}: ${completed.stderr.toString()}`;
    const missing = [ancestor, descendant].find((rev) => commitSha(repo, rev) === null);
    throw missing === undefined ? new GitError(message) : new MissingCommit(message, missing);
  }
  const answer = completed.returncode === 0;
  if (OBJECT_ID.test(ancestor) && OBJECT_ID.test(descendant)) ancestryAnswers.set(key, answer);
  return answer;
}

export function preloadAncestorsOf(repo: string, descendant: string, candidates: string[]): void {
  const unanswered = commitsAmong(repo, descendant, candidates).filter((candidate) => !ancestryAnswers.has(ancestryKey(repo, candidate, descendant)));
  const outsideDescendant = commitsReachable(repo, [], unanswered, descendant);
  if (outsideDescendant === null) return;
  for (const candidate of unanswered) {
    ancestryAnswers.set(ancestryKey(repo, candidate, descendant), !outsideDescendant.has(candidate));
  }
}

export function preloadDescendantsOf(repo: string, ancestor: string, candidates: string[]): void {
  const unanswered = commitsAmong(repo, ancestor, candidates).filter((candidate) => !ancestryAnswers.has(ancestryKey(repo, ancestor, candidate)));
  const afterAncestor = commitsReachable(repo, ['--ancestry-path'], unanswered, ancestor);
  if (afterAncestor === null) return;
  for (const candidate of unanswered) {
    ancestryAnswers.set(ancestryKey(repo, ancestor, candidate), candidate === ancestor || afterAncestor.has(candidate));
  }
}

function commitsAmong(repo: string, anchor: string, candidates: string[]): string[] {
  const ids = [...new Set([anchor, ...candidates])].filter((id) => OBJECT_ID.test(id));
  const untyped = ids.filter((id) => !commitObjects.has(objectKey(repo, id)));
  if (untyped.length > 0) recordObjectTypes(repo, untyped);
  const isCommit = (id: string): boolean => commitObjects.get(objectKey(repo, id)) === true;
  return isCommit(anchor) ? [...new Set(candidates)].filter(isCommit) : [];
}

function recordObjectTypes(repo: string, ids: string[]): void {
  const args = ['cat-file', '--batch-check=%(objecttype)'];
  const completed = runUnchecked(repo, args, { input: ids.join('\n') + '\n' });
  if (completed.returncode !== 0) return;
  const types = gateLines(args, completed.stdout.toString());
  if (types.length !== ids.length) return;
  ids.forEach((id, index) => commitObjects.set(objectKey(repo, id), types[index] === COMMIT_OBJECT_TYPE));
}

function commitsReachable(repo: string, walk: string[], from: string[], butNotFrom: string): Set<string> | null {
  if (from.length < MIN_PAIRS_WORTH_ONE_QUERY) return null;
  const args = ['rev-list', ...walk, '--stdin'];
  const completed = runUnchecked(repo, args, { input: [...from, '^' + butNotFrom, ''].join('\n') });
  if (completed.returncode !== 0) return null;
  return new Set(gateLines(args, completed.stdout.toString()));
}

function objectKey(repo: string, id: string): string {
  return [repo, id].join('\0');
}

function ancestryKey(repo: string, ancestor: string, descendant: string): string {
  return [repo, ancestor, descendant].join('\0');
}

export function firstParentAncestors(repo: string, head: string, stop: string): string[] {
  const args = ['rev-list', '--first-parent', head + '^', '^' + stop];
  const line = gateLines(args, runOrThrow(repo, args).stdout.toString());
  const last = line.length > 0 ? line.at(-1)! : head;
  if (commitSha(repo, last + '^') !== stop) return [];
  return [...line, stop];
}

export function lastCommitTouching(repo: string, base: string, head: string, path: string): string {
  return textOrThrow(repo, ['log', '-1', '--format=%H', `${base}..${head}`, '--', path]);
}

export function mergedBlob(repo: string, current: string, base: string, other: string): string | null {
  return exactOutputOrNull(repo, ['merge-file', '--object-id', current, base, other]);
}

export function fetch(repo: string, args: string[]): void {
  runOrThrow(repo, ['fetch', '--quiet', ...args], { timeoutSeconds: FETCH_TIMEOUT_SECONDS });
}

export const REGULAR_FILE_MODES = ['100644', '100755'];

export function diffEntries(repo: string, oldTree: string, newTree: string): PathEntry[] {
  const fields = splitOnNul(runOrThrow(repo, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev',
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
  const raw = runOrThrow(repo, ['diff-tree', '-r', '--numstat', '-z', '--no-renames', '--ignore-submodules=none',
    oldTree, newTree]).stdout;
  const stats = new Map<string, PathStat>();
  for (const record of splitOnNul(raw).filter((item) => item.length > 0)) {
    const [added, deleted, path] = splitLimit(decodeStrict(record, 'a path in the git diff'), '\t', 2) as [string, string, string];
    const binary = added === '-';
    stats.set(path, { added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted) });
  }
  return stats;
}

export function treeEntry(repo: string, tree: string, path: string): TreeEntry | null {
  return treeListing(repo, tree).get(path) ?? null;
}

export function isObjectId(name: string): boolean {
  return OBJECT_ID.test(name);
}

export function isPlainPath(path: string): boolean {
  return PLAIN_PATH.test(path);
}

export function sizedObjectsAt(repo: string, places: Array<[tree: string, path: string]>): Array<SizedObject | null> | null {
  if (!places.every(([tree, path]) => isObjectId(tree) && isPlainPath(path))) return null;
  return sizedObjects(repo, places.map(([tree, path]) => `${tree}:${path}`));
}

export function sizedObjectsNamed(repo: string, ids: string[]): Array<SizedObject | null> | null {
  return ids.every((id) => OBJECT_ID.test(id)) ? sizedObjects(repo, ids) : null;
}

function sizedObjects(repo: string, names: string[]): Array<SizedObject | null> | null {
  if (names.length === 0) return [];
  const args = ['cat-file', '--batch-check=%(objectname) %(objectsize)'];
  const completed = runUnchecked(repo, args, { input: names.join('\n') + '\n' });
  if (completed.returncode !== 0) return null;
  const answers = gateLines(args, completed.stdout.toString());
  if (answers.length !== names.length) return null;
  return answers.map((answer) => {
    const sized = SIZED_OBJECT.exec(answer);
    return sized ? { id: sized[1]!, size: Number.parseInt(sized[2]!, 10) } : null;
  });
}

function treeListing(repo: string, tree: string): Map<string, TreeEntry> {
  const key = [repo, tree].join('\0');
  const cached = treeListings.get(key);
  if (cached) return cached;
  const listing = new Map<string, TreeEntry>();
  for (const record of splitOnNul(runOrThrow(repo, ['ls-tree', '-r', '-t', '-z', tree]).stdout)) {
    if (record.length === 0) continue;
    const text = utf8OrNull(record);
    if (text === null) continue;
    const [mode, , rest] = splitLimit(text, ' ', 2) as [string, string, string];
    const [object, path] = splitLimit(rest, '\t', 1) as [string, string];
    listing.set(path, [mode, object]);
  }
  if (OBJECT_ID.test(tree)) treeListings.set(key, listing);
  return listing;
}

function utf8OrNull(record: Buffer): string | null {
  try {
    return decodeStrict(record, 'a path in the git tree');
  } catch (error) {
    if (error instanceof InvalidUtf8Error) return null;
    throw error;
  }
}

export function submoduleRoots(repo: string): string[] {
  const args = ['submodule', 'foreach', '--quiet', '--recursive', 'pwd'];
  const roots = gateLines(args, runOrThrow(repo, args).stdout.toString());
  return roots.map((root) => resolveLinks(root));
}

export function submoduleUrl(repo: string, commit: string, path: string): string | null {
  const completed = runUnchecked(repo, ['config', '--blob', commit + ':.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.path$']);
  if (completed.returncode !== 0) return null;
  for (const record of completed.stdout.toString().split('\0')) {
    const [key, value] = record.split('\n');
    if (value !== path || key === undefined) continue;
    const name = key.slice('submodule.'.length, -'.path'.length);
    return exactOutputOrNull(repo, ['config', '--blob', commit + ':.gitmodules', '--get', `submodule.${name}.url`]);
  }
  return null;
}

export function snapshotTree(repo: string): string {
  const index = join(tmpdir(), 'keel-index-' + randomBytes(TEMP_INDEX_RANDOM_BYTES).toString('hex'));
  closeSync(openSync(index, 'wx'));
  unlinkSync(index);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const options = { env, timeoutSeconds: SNAPSHOT_TIMEOUT_SECONDS };
  try {
    runOrThrow(repo, ['--work-tree', repo, 'read-tree', 'HEAD'], options);
    runOrThrow(repo, ['--work-tree', repo, 'add', '-A'], options);
    return textOrThrow(repo, ['--work-tree', repo, 'write-tree'], options);
  } finally {
    if (existsSync(index)) unlinkSync(index);
  }
}

export function checkoutSnapshot(repo: string, tree: string, directory: string): void {
  runOrThrow(directory, ['init', '-q', '--template=']);
  copyRemotes(repo, directory);
  const objects = textOrThrow(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  mkdirSync(join(directory, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(join(directory, '.git', 'objects', 'info', 'alternates'), objects + '\n');
  const parent = textOrThrow(repo, ['rev-parse', 'HEAD']);
  const commit = textOrThrow(directory, ['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', SNAPSHOT_COMMIT_MESSAGE],
    { env: { ...process.env, ...SNAPSHOT_IDENTITY } });
  runOrThrow(directory, ['reset', '-q', '--hard', commit], { timeoutSeconds: SNAPSHOT_TIMEOUT_SECONDS });
}

function copyRemotes(repo: string, directory: string): void {
  const listed = runUnchecked(repo, ['config', '--local', '--includes', '-z', '--get-regexp', REMOTE_KEYS]).stdout;
  for (const record of splitOnNul(listed).filter((entry) => entry.length > 0)) {
    const entry = record.toString();
    const separator = entry.indexOf('\n');
    if (separator < 0) runOrThrow(directory, ['config', '--add', entry, VALUELESS_KEY_MEANS]);
    else runOrThrow(directory, ['config', '--add', entry.slice(0, separator), anchoredAtRepo(repo, entry.slice(0, separator), entry.slice(separator + 1))]);
  }
}

function anchoredAtRepo(repo: string, key: string, value: string): string {
  if (!REMOTE_URL_KEY.test(key) || !isRelativePath(value)) return value;
  return resolve(repo, value);
}

function isRelativePath(url: string): boolean {
  return !isAbsolute(url) && !url.startsWith(HOME_PREFIX) && !URL_SCHEME.test(url) && !SCP_LIKE.test(url);
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
