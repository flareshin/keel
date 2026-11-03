import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { getJson } from "../src/http.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test("getJson returns the parsed body of a 2xx response", async () => {
  globalThis.fetch = async () => new Response('{"celsius": 21.4}', { status: 200 })
  assert.deepEqual(await getJson("https://weather.example.invalid/now"), { celsius: 21.4 })
})

test("getJson rejects a non-2xx response with its status", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 })
  await assert.rejects(getJson("https://weather.example.invalid/now"), /failed with 503/)
})
