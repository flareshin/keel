import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { pythonJsonDumps, pythonJsonLoads, pythonJsonRawDecode } from "../../measure/lib/measurekit/pyjson.ts"
import { shlexQuote } from "../../measure/lib/measurekit/shlex.ts"
import { recordedAnswers } from "../recorded.ts"

type Case = [string, unknown[]]

function compare(cases: Case[], actual: unknown[]): void {
  const expected = recordedAnswers("link-compat", cases)
  const mismatches = cases.flatMap((entry, index) => (JSON.stringify(expected[index]) === JSON.stringify(actual[index]) ? [] : [{ entry, expected: expected[index], actual: actual[index] }]))
  assert.deepEqual(mismatches, [])
}

const JSON_FIXTURES = [
  '{"b": 1, "a": [1.0, 2.5, -0.0, 1e5, 1E3, 1e-7, 123456789012345678901234567890, 0.1], "c": {"z": null, "y": true, "x": false}}',
  '{"\u00e9": "\u00e9\u{1F600}", "\\ud83d\\ude00": "\\u007f\\u0000\\u001f\\n\\t\\"\\\\/", "k": [], "o": {}}',
  '{"nested": {"env": [1, [2, {"deep": "\u2028\u2029"}]]}}',
  '"plain"',
  "[]",
  "{}",
]

describe("python compatibility helpers for link", () => {
  it("pythonJsonDumps_agreesWithJsonDumps_whenEnsureAsciiIsOffOrOn", () => {
    const cases: Case[] = []
    const actual: string[] = []
    for (const text of JSON_FIXTURES) {
      for (const sortKeys of [true, false]) {
        for (const indent of [null, 2]) {
          for (const ensureAscii of [true, false]) {
            cases.push(["dumps", [text, sortKeys, indent, ensureAscii]])
            actual.push(pythonJsonDumps(pythonJsonLoads(text), { sortKeys, indent: indent ?? undefined, ensureAscii }))
          }
        }
      }
    }
    compare(cases, actual)
  })

  it("pythonJsonRawDecode_returnsTheEndOfTheValue_likeRawDecode", () => {
    const text = '{"a" : [1, 2,3] , "b":"x\\"y" ,  "c": -1.5e3 }'
    const starts = [0, ...['"a"', "[1", '"b"', '"x', '"c"', "-1.5e3"].map((fragment) => text.indexOf(fragment))]
    const cases: Case[] = starts.map((index) => ["raw", [text, index]])
    compare(cases, starts.map((index) => pythonJsonRawDecode(text, index)[1]))
  })

  it("shlexQuote_agreesWithShlexQuote_onSafeUnsafeAndQuotedText", () => {
    const texts = ["", "plain", "with space", "it's", "a'b'c", "tab\there", "new\nline", "$HOME", "~/x", "a=b:c,d@e%f+g./-h", "caf\u00e9", `da ta's \u00e9 \u{1F600}`, "\\", '"', "*", "a;b|c&d"]
    const cases: Case[] = texts.map((text) => ["quote", [text]])
    compare(cases, texts.map(shlexQuote))
  })
})
