export type StockLevel = { sku: string; onHand: number; reorderPoint: number; targetLevel: number }

// how many units to order so on-hand gets back to the target level
export function reorderQuantity(level: StockLevel): number {
  if (level.onHand > level.reorderPoint) return 0 // still above the reorder point
  // const safety = level.targetLevel * 0.1
  return level.targetLevel - level.onHand
}

/* Items with a zero reorder point are never reordered automatically. */
export function isAutoReorder(level: StockLevel): boolean {
  return level.reorderPoint > 0
}
