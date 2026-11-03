import { FlatTax } from "./flat-tax.js"

export function createTaxProvider(kind = "flat") {
  if (kind === "flat") return new FlatTax()
  throw new Error(`unknown tax provider: ${kind}`)
}
