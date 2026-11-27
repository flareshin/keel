import { RUN_TIME_WORD_RE } from '../../hooks/lib/hookkit/commands.ts';
import * as gitcmd from './gitcmd.ts';

export type PushedRef = { source: string; destination: string | null };

export type PushTarget = { remote: string | null; namesRefspecs: boolean; spec: PushedRef };

const CONFIG_KEY_MISSING = 1;
const CURRENT_BRANCH_NAMES: ReadonlySet<string> = new Set(['HEAD', '@']);
const BRANCH_REF_PREFIXES = ['refs/heads/', 'heads/'];
const UPSTREAM_PUSH_MODES: ReadonlySet<string> = new Set(['upstream', 'tracking']);
const DEFAULT_PUSH_MODE = 'simple';

export const PUSH_OF_HEAD: PushTarget = { remote: gitcmd.DEFAULT_REMOTE, namesRefspecs: true, spec: { source: 'HEAD', destination: null } };

export function mayLandOn(repoRoot: string, branch: string, target: PushTarget): boolean {
  return pushedBranches(repoRoot, target).some((pushed) => pushed === null || pushed === branch);
}

function pushedBranches(repoRoot: string, target: PushTarget): Array<string | null> {
  const { spec } = target;
  if (spec.destination !== null) return [branchNamed(spec.destination)];
  if (storedConfig(repoRoot, `remote.${target.remote || gitcmd.pushRemote(repoRoot)}.push`) !== null) return [null];
  const mode = storedConfig(repoRoot, 'push.default') ?? DEFAULT_PUSH_MODE;
  if (target.namesRefspecs) return branchesOfANamedSource(repoRoot, spec.source, mode);
  return branchesOfABarePush(repoRoot, mode);
}

function branchesOfANamedSource(repoRoot: string, source: string, mode: string): Array<string | null> {
  const branch = CURRENT_BRANCH_NAMES.has(source) ? gitcmd.currentBranch(repoRoot) : branchNamed(source);
  if (branch === null) return [null];
  return UPSTREAM_PUSH_MODES.has(mode) ? withItsUpstream(repoRoot, branch) : [branch];
}

function branchesOfABarePush(repoRoot: string, mode: string): Array<string | null> {
  if (mode === 'nothing') return [];
  const branch = gitcmd.currentBranch(repoRoot);
  if (branch === null) return [null];
  if (mode === 'current' || mode === DEFAULT_PUSH_MODE) return [branch];
  if (!UPSTREAM_PUSH_MODES.has(mode)) return [null];
  return withItsUpstream(repoRoot, branch);
}

function withItsUpstream(repoRoot: string, branch: string): Array<string | null> {
  const merge = storedConfig(repoRoot, `branch.${branch}.merge`);
  return merge === null ? [branch] : [branch, branchNamed(merge)];
}

function branchNamed(ref: string): string | null {
  if (RUN_TIME_WORD_RE.test(ref) || CURRENT_BRANCH_NAMES.has(ref)) return null;
  const prefix = BRANCH_REF_PREFIXES.find((candidate) => ref.startsWith(candidate));
  return prefix === undefined ? ref : ref.slice(prefix.length);
}

function storedConfig(repoRoot: string, key: string): string | null {
  const read = gitcmd.runUnchecked(repoRoot, ['config', '--get', key]);
  if (read.returncode === CONFIG_KEY_MISSING) return null;
  if (read.returncode !== 0) throw new Error(`git config --get ${key}: ${read.stderr.toString().trim()}`);
  return read.stdout.toString().trim();
}
