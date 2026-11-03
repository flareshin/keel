import assert from "node:assert/strict"
import { test } from "node:test"

import { priceOrder } from "../src/pricing.js"

test("priceOrder adds the east tax rate to the subtotal", () => {
  assert.deepEqual(priceOrder({ region: "east", lines: [{ unitCents: 250, quantity: 4 }] }), { subtotalCents: 1000, taxCents: 80, totalCents: 1080 })
})

test("priceOrder charges no tax in a region without a rate", () => {
  assert.deepEqual(priceOrder({ region: "north", lines: [{ unitCents: 999, quantity: 1 }] }), { subtotalCents: 999, taxCents: 0, totalCents: 999 })
})
