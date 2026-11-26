import { currentLoadFactor } from '../lib/precheck/baseline.ts';

export function loadScaledMs(budgetMs: number, ceilingMs = Number.POSITIVE_INFINITY, loadFactor = currentLoadFactor()): number {
  return Math.min(budgetMs * loadFactor, ceilingMs);
}
