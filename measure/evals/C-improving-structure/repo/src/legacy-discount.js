export function legacyDiscountCents(subtotalCents, code) {
  if (code === "SPRING10") return Math.round(subtotalCents * 0.1)
  return 0
}
