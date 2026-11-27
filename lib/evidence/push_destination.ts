import { RUN_TIME_WORD_RE } from '../../hooks/lib/hookkit/commands.ts';
import * as gitcmd from './gitcmd.ts';
import type { ConfigView } from './gitcmd.ts';

export type PushedRef = { source: string; destination: string | null };

export type PushTarget = { remote: string | null; namesRefspecs: boolean; spec: PushedRef };

const CURRENT_BRANCH_NAMES: ReadonlySet<string> = new Set(['HEAD', '@']);
const BRANCH_REF_PREFIXES = ['refs/heads/', 'heads/'];
const UPSTREAM_PUSH_MODES: ReadonlySet<string> = new Set(['upstream', 'tracking']);
const DEFAULT_PUSH_MODE = 'simple';

export const PUSH_OF_HEAD: PushTarget = { remote: gitcmd.DEFAULT_REMOTE, namesRefspecs: true, spec: { source: 'HEAD', destination: null } };

export function mayLandOn(repoRoot: string, branch: string, target: PushTarget, view?: ConfigView): boolean {
  return pushedBranches(repoRoot, target, view).some((pushed) => pushed === null || pushed === branch);
}

function pushedBranches(repoRoot: string, target: PushTarget, view?: ConfigView): Array<string | null> {
  const { spec } = target;
  if (spec.destination !== null) return [branchNamed(spec.destination)];
  if (gitcmd.storedConfig(repoRoot, [`remote.${target.remote || gitcmd.pushRemote(repoRoot, view)}.push`], view) !== null) return [null];
  const mode = gitcmd.storedConfig(repoRoot, ['push.default'], view) ?? DEFAULT_PUSH_MODE;
  if (target.namesRefspecs) return branchesOfANamedSource(repoRoot, spec.source, mode, view);
  return branchesOfABarePush(repoRoot, mode, view);
}

function branchesOfANamedSource(repoRoot: string, source: string, mode: string, view?: ConfigView): Array<string | null> {
  const branch = CURRENT_BRANCH_NAMES.has(source) ? gitcmd.currentBranch(repoRoot) : branchNamed(source);
  if (branch === null) return [null];
  return UPSTREAM_PUSH_MODES.has(mode) ? withItsUpstream(repoRoot, branch, view) : [branch];
}

function branchesOfABarePush(repoRoot: string, mode: string, view?: ConfigView): Array<string | null> {
  if (mode === 'nothing') return [];
  const branch = gitcmd.currentBranch(repoRoot);
  if (branch === null) return [null];
  if (mode === 'current' || mode === DEFAULT_PUSH_MODE) return [branch];
  if (!UPSTREAM_PUSH_MODES.has(mode)) return [null];
  return withItsUpstream(repoRoot, branch, view);
}

function withItsUpstream(repoRoot: string, branch: string, view?: ConfigView): Array<string | null> {
  const merge = gitcmd.storedConfig(repoRoot, [`branch.${branch}.merge`], view);
  return merge === null ? [branch] : [branch, branchNamed(merge)];
}

function branchNamed(ref: string): string | null {
  if (RUN_TIME_WORD_RE.test(ref) || CURRENT_BRANCH_NAMES.has(ref)) return null;
  const prefix = BRANCH_REF_PREFIXES.find((candidate) => ref.startsWith(candidate));
  return prefix === undefined ? ref : ref.slice(prefix.length);
}
