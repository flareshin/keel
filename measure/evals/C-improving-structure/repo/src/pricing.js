import { createTaxProvider } from "./tax-provider-factory.js"

const taxProvider = createTaxProvider()

export function priceOrder(order) {
  const subtotalCents = order.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0)
  const taxCents = Math.round(subtotalCents * taxProvider.rateFor(order.region))
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents }
}
