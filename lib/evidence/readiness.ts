import * as gitcmd from './gitcmd.ts';
import * as pushDestination from './push_destination.ts';
import * as registry from './registry.ts';
import * as verify from './verify.ts';
import * as writers from './writers.ts';

export type ApprovalCheck = 'as-the-push' | 'skipped';

export type ReadinessReason = { rule_id: string; text: string };

export type PushReadiness = {
  repo: string | null;
  head: string;
  gated: boolean;
  ok: boolean;
  risk: string | null;
  root_run_id: string | null;
  reasons: ReadinessReason[];
};

export function pushReadiness(repoPath: string, approval: ApprovalCheck = 'as-the-push'): PushReadiness {
  const repoRoot = gitcmd.toplevel(repoPath);
  if (repoRoot === null) throw new writers.Usage(`${repoPath} is not in a git repository`);
  const head = gitcmd.commitSha(repoRoot, 'HEAD');
  if (head === null) throw new writers.Usage(`${repoRoot} has no commit at HEAD`);
  const repoKey = registry.originKey(repoRoot);
  const row = registry.lookup(repoKey);
  if (!registry.isGated(row)) return { repo: repoKey, head, gated: false, ok: true, risk: null, root_run_id: null, reasons: [] };
  const baseRef = 'origin/' + row!.integrationBase;
  if (!gitcmd.refExists(repoRoot, 'refs/remotes/' + baseRef)) throw new writers.Usage(`base ${baseRef} is missing: run \`git fetch origin\``);
  const mergeBase = gitcmd.mergeBase(repoRoot, baseRef, head);
  if (mergeBase === null) throw new writers.Usage(`no merge base between ${baseRef} and HEAD`);
  const needsApproval = approval === 'as-the-push'
    && (registry.pushNeedsApproval(row!) || pushDestination.mayLandOn(repoRoot, row!.integrationBase, pushDestination.BARE_PUSH));
  const decision = verify.judge({ repoRoot, repoKey: repoKey!, row: row!, head, mergeBase, needsApproval, promote: false });
  return {
    repo: repoKey, head, gated: true, ok: decision.ok, risk: decision.riskClass, root_run_id: decision.rootRunId,
    reasons: decision.reasons.map((reason) => ({ rule_id: reason.ruleId, text: reason.text })),
  };
}
