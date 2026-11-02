// Copyright 2024 Stockroom Ltd.

export type LineItem = { sku: string; units: number; unitPriceCents: number }

/**
 * Returns the line total in cents.
 * @param item the line item
 */
export function lineTotalCents(item: LineItem): number {
  // multiply units by the unit price
  return item.units * item.unitPriceCents
}

// members get 5% off, rounded down to whole cents
export function memberPriceCents(totalCents: number): number {
  return Math.floor(totalCents * 0.95)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function legacyCoupon(code: string): number {
  // old coupons are worth nothing now
  return 0
}
