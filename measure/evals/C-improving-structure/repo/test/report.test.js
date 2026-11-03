import assert from "node:assert/strict"
import { test } from "node:test"

import { dailyRevenueCents } from "../src/report.js"

test("dailyRevenueCents sums the totals of every order", () => {
  const orders = [{ region: "east", lines: [{ unitCents: 1000, quantity: 1 }] }, { region: "west", lines: [{ unitCents: 2000, quantity: 1 }] }]
  assert.equal(dailyRevenueCents(orders), 1080 + 2120)
})
