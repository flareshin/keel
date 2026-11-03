const RATES = { east: 0.08, west: 0.06 }

export class FlatTax {
  rateFor(region) {
    return RATES[region] ?? 0
  }
}
