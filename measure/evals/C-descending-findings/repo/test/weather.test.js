import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { currentTemperature } from "../src/weather.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test("currentTemperature rounds the reading to whole degrees", async () => {
  globalThis.fetch = async () => new Response('{"celsius": 21.6}', { status: 200 })
  assert.equal(await currentTemperature("Seoul"), "22°C")
})
