import { buildChains, countNeedsFixesLinks, NEEDS_FIXES } from "../../../lib/evidence/chain.ts"
import type { Chain } from "../../../lib/evidence/chain.ts"
import * as store from "../../../lib/evidence/store.ts"

export interface ReviewRounds {
  chains: number
  roots_needing_fixes: number
  chains_by_needs_fixes_rounds: Record<string, number>
}

export function summarizeReviewRounds(): ReviewRounds | { error: string } {
  try {
    return countRounds(store.repoKeys("review").flatMap((repoKey) => newestChainPerRoot(buildChains(store.loadReviews(repoKey)))))
  } catch (error) {
    if (!(error instanceof store.EvidenceError || error instanceof store.EvidenceTooDeepError)) throw error
    return { error: error.message }
  }
}

function newestChainPerRoot(newestFirstChains: Chain[]): Chain[] {
  const byRoot = new Map<string, Chain>()
  for (const chain of newestFirstChains) {
    if (!byRoot.has(chain.rootRunId)) byRoot.set(chain.rootRunId, chain)
  }
  return [...byRoot.values()]
}

function countRounds(chains: Chain[]): ReviewRounds {
  const byRounds: Record<string, number> = {}
  for (const chain of chains) {
    const rounds = String(countNeedsFixesLinks(chain))
    byRounds[rounds] = (byRounds[rounds] ?? 0) + 1
  }
  return {
    chains: chains.length,
    roots_needing_fixes: chains.filter((chain) => chain.root.verdict === NEEDS_FIXES).length,
    chains_by_needs_fixes_rounds: byRounds,
  }
}
