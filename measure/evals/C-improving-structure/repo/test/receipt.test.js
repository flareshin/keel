import assert from "node:assert/strict"
import { test } from "node:test"

import { formatReceipt } from "../src/receipt.js"

test("formatReceipt prints subtotal, tax and total in dollars", () => {
  assert.equal(formatReceipt({ region: "west", lines: [{ unitCents: 500, quantity: 3 }] }), "subtotal 15.00\ntax 0.90\ntotal 15.90")
})
