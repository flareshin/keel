import { computeTotal } from "./pricing-service.js"

export function formatReceipt(order) {
  const { subtotalCents, taxCents, totalCents } = computeTotal(order)
  return [`subtotal ${dollars(subtotalCents)}`, `tax ${dollars(taxCents)}`, `total ${dollars(totalCents)}`].join("\n")
}

function dollars(cents) {
  return (cents / 100).toFixed(2)
}
