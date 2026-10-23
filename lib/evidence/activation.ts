import { buildChains } from './chain.ts';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import * as registry from './registry.ts';
import * as store from './store.ts';
import { TimeoutExpired } from './subprocess.ts';
import * as verify from './verify.ts';

export function approvedFastForward(repo: string, target: unknown): boolean {
  if (!env.isSha(target)) return false;
  try {
    const key = registry.originKey(repo);
    const row = registry.lookup(key);
    if (!row || row.gate !== 'code' || gitcmd.objectType(repo, target) !== 'commit') return false;
    if (gitcmd.text(repo, ['status', '--porcelain', '--untracked-files=all'])) return false;
    const head = gitcmd.commitSha(repo, 'HEAD');
    if (!head || gitcmd.mergeBase(repo, head, target) !== head) return false;
    const tree = gitcmd.treeOfCommit(repo, target);
    const approved = new Set<string>();
    for (const chain of buildChains(store.loadReviews(key!))) {
      const proof = verify.boundEvidence('approval', chain.rootRunId, key!, chain.head.evidence_id);
      if (chain.head.reviewed_tree === tree && chain.head.verdict === 'PASS' && proof && (proof['commits'] ?? {})[key!] === target) {
        approved.add(chain.rootRunId);
      }
    }
    if (approved.size === 0) return false;
    const chains = buildChains(store.loadReviews(key!));
    if (head === target) {
      return chains.some((chain) => approved.has(chain.rootRunId) && verify.provenanceReasons(chain).length === 0);
    }
    const decision = verify.judge({ repoRoot: repo, repoKey: key!, row, head: target, mergeBase: head, needsApproval: true });
    return decision.ok && decision.rootRunIds.some((root) => approved.has(root));
  } catch (error) {
    if (isExpectedFailure(error)) return false;
    throw error;
  }
}

function isExpectedFailure(error: unknown): boolean {
  return error instanceof gitcmd.GitError || error instanceof registry.RegistryError || error instanceof store.EvidenceError
    || error instanceof TimeoutExpired || verify.isValidationFailure(error);
}
