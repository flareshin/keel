import { currentLoadFactor } from '../lib/precheck/baseline.ts';

export function loadScaledMs(budgetMs: number, ceilingMs = Number.POSITIVE_INFINITY): number {
  return Math.min(budgetMs * currentLoadFactor(), ceilingMs);
}
