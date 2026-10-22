import type { ReviewEvidence } from './store.ts';

export type ReviewedPath = [blob: string | null, mode: string];

export interface Chain {
  rootRunId: string;
  links: ReviewEvidence[];
  reviewed: Map<string, ReviewedPath>;
  head: ReviewEvidence;
  root: ReviewEvidence;
}

export function buildChains(reviews: ReviewEvidence[]): Chain[] {
  const byId = new Map(reviews.map((review) => [review.evidence_id, review]));
  const followed = new Set(reviews.filter((review) => review.since).map((review) => review.since));
  const chains: Chain[] = [];
  for (const head of reviews) {
    const links = followed.has(head.evidence_id) ? null : trail(head, byId);
    if (links) {
      const reviewed = new Map<string, ReviewedPath>();
      for (const link of links) {
        for (const entry of link.paths) reviewed.set(entry.path, [entry.blob, entry.mode]);
      }
      chains.push({ rootRunId: head.root_run_id, links, reviewed, head: links.at(-1)!, root: links[0]! });
    }
  }
  return chains.sort((left, right) => newestFirst(left.head, right.head));
}

function newestFirst(left: ReviewEvidence, right: ReviewEvidence): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  if (left.evidence_id !== right.evidence_id) return left.evidence_id < right.evidence_id ? 1 : -1;
  return 0;
}

function trail(head: ReviewEvidence, byId: Map<string, ReviewEvidence>): ReviewEvidence[] | null {
  const links = [head];
  const seen = new Set([head.evidence_id]);
  while (links.at(-1)!.since) {
    const previous = byId.get(links.at(-1)!.since!);
    if (previous === undefined || seen.has(previous.evidence_id) || previous.root_run_id !== head.root_run_id) return null;
    links.push(previous);
    seen.add(previous.evidence_id);
  }
  const root = links.at(-1)!;
  return root.root_run_id === root.run_id ? links.reverse() : null;
}
