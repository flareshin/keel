import { priceOrder } from "./pricing.js"

export function computeTotal(order) {
  return priceOrder(order)
}
