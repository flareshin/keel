import { computeTotal } from "./pricing-service.js"

export function dailyRevenueCents(orders) {
  return orders.reduce((sum, order) => sum + computeTotal(order).totalCents, 0)
}
