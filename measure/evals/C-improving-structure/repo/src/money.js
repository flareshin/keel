export function dollars(cents) {
  return (cents / 100).toFixed(2)
}

export function legacyDiscountCents(subtotalCents, code) {
  if (code === "SPRING10") return Math.round(subtotalCents * 0.1)
  return 0
}
