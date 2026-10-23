import assert from "node:assert/strict"
import { after, describe, it } from "node:test"

import { driftedOwnedKeys, listDroppedItems, spliceOwnedKeys } from "../../lib/link/settings_json.ts"
import { errorName } from "../../measure/lib/measurekit/pyerrors.ts"
import { pythonJsonLoads } from "../../measure/lib/measurekit/pyjson.ts"
import type { JsonObject } from "../../measure/lib/measurekit/pyvalue.ts"
import { recordedAnswers } from "../recorded.ts"

type Case = [string, string, string]

const TRICKY_CHARS = ["a", "Z", " ", "\t", "\n", "\u0000", "\u001f", "\u007f", "\u00e9", "\u2028", "\u{1F600}", "\\", '"', "/", "{", "}", ",", ":", "[", "]"]
const NUMBER_TEXTS = ["0", "-1", "42", "1.0", "2.5", "-0.0", "1e3", "1E-7", "0.1", "12345678901234567890", "12345678901234567890.5", "1e400"]
const WHITESPACE = ["", " ", "\n", "\t", "\n  ", "\n    ", "  "]
const OWNED_KEYS = ["hooks", "permissions", "env"]
const MEMBER_KEYS = [...OWNED_KEYS, "model", "theme", "nested", "\u00e9", "10", "2"]
const STRING_POOL = ["Read", "Bash(x:*)", "\u00e9", "\u{1F600}", "a b", "Glob"]
const PERMISSION_KEYS = ["allow", "deny", "ask", "defaultMode", "extra"]

let compared = 0
let mismatches = 0

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const random = seededRandom(20261022)
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
const whitespace = () => pick(WHITESPACE)

function randomString(): string {
  return Array.from({ length: Math.floor(random() * 5) }, () => pick(TRICKY_CHARS)).join("")
}

function jsonStringLiteral(text: string): string {
  const literal = JSON.stringify(text)
  return random() < 0.5 ? literal : literal.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function randomJson(depth: number): string {
  const kind = Math.floor(random() * (depth > 2 ? 4 : 6))
  if (kind === 0) return pick(["null", "true", "false"])
  if (kind === 1) return pick(NUMBER_TEXTS)
  if (kind <= 3) return jsonStringLiteral(randomString())
  if (kind === 4) {
    const items = Array.from({ length: Math.floor(random() * 4) }, () => whitespace() + randomJson(depth + 1) + whitespace())
    return `[${items.join(",")}]`
  }
  return randomObject(depth + 1, MEMBER_KEYS)
}

function randomObject(depth: number, keys: readonly string[]): string {
  const members = Array.from({ length: Math.floor(random() * 4) }, () => `${whitespace()}${jsonStringLiteral(pick(keys))}${whitespace()}:${whitespace()}${randomJson(depth + 1)}${whitespace()}`)
  return `{${members.join(",")}${whitespace()}}`
}

function randomMerged(): string {
  const present = OWNED_KEYS.filter(() => random() < 0.5)
  return `{${present.map((key) => `${JSON.stringify(key)}: ${randomJson(1)}`).join(", ")}}`
}

function structuredSettings(): string {
  const strings = () => Array.from({ length: Math.floor(random() * 4) }, () => JSON.stringify(pick(STRING_POOL)))
  const hook = () =>
    pick([
      `{"type": "command", "command": ${JSON.stringify(pick(STRING_POOL))}, "timeout": ${pick(["5", "5.0", "60"])}}`,
      '{"type": "prompt", "prompt": "p"}',
    ])
  const group = () => `{"matcher": ${JSON.stringify(pick(["Bash", "Edit", ""]))}, "hooks": [${hook()}]}`
  const section = (key: string): string => {
    if (key === "hooks") return `{${["Stop", "PreToolUse"].filter(() => random() < 0.6).map((event) => `"${event}": [${group()}, ${group()}]`).join(", ")}}`
    if (key === "env") return `{${["A", "B", "C"].filter(() => random() < 0.6).map((name) => `"${name}": ${pick(['"v1"', '"v2"', "1"])}`).join(", ")}}`
    const permissions = PERMISSION_KEYS.filter(() => random() < 0.5).map((name) => `"${name}": ${["allow", "deny", "ask"].includes(name) && random() < 0.8 ? `[${strings().join(", ")}]` : pick(['"auto"', "1", "[]", '"x"'])}`)
    return `{${permissions.join(", ")}}`
  }
  const members = OWNED_KEYS.filter(() => random() < 0.7).map((key) => `${JSON.stringify(key)}: ${random() < 0.05 ? randomJson(2) : section(key)}`)
  return `{${members.join(", ")}}`
}

function typescriptResult(operation: string, first: string, second: string): unknown {
  try {
    if (operation === "splice") return spliceOwnedKeys(first, pythonJsonLoads(second) as JsonObject)
    const live = pythonJsonLoads(first) as JsonObject
    const merged = pythonJsonLoads(second) as JsonObject
    if (operation === "dropped") return listDroppedItems(live, merged)
    return driftedOwnedKeys({ path: "settings.json", text: first, values: live }, merged)
  } catch (error) {
    return `ERR ${errorName(error)}: ${(error as Error).message}`
  }
}

function assertParity(cases: Case[]): void {
  const expected = recordedAnswers("link-settings-parity", cases)
  const bad = cases.flatMap(([operation, first, second], index) => {
    const actual = typescriptResult(operation, first, second)
    return JSON.stringify(actual) === JSON.stringify(expected[index]) ? [] : [{ operation, first, second, expected: expected[index], actual }]
  })
  compared += cases.length
  mismatches += bad.length
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} mismatches`)
}

after(() => console.log(`parity: ${compared} cases, ${mismatches} mismatches`))

describe("link settings functions match the python module", () => {
  it("spliceOwnedKeys_agrees_onRandomTopLevelObjectsAndMerges", () => {
    const cases: Case[] = Array.from({ length: 500 }, () => {
      const members = Array.from({ length: Math.floor(random() * 6) }, () => `${whitespace()}${JSON.stringify(pick(MEMBER_KEYS))}${whitespace()}:${whitespace()}${randomJson(1)}${whitespace()}`)
      return ["splice", `${whitespace()}{${members.join(",")}${whitespace()}}${pick(["", "\n"])}`, randomMerged()]
    })
    assertParity(cases)
  })

  it("listDroppedItems_agrees_onRandomLiveAndMergedSettings", () => {
    assertParity(Array.from({ length: 400 }, () => ["dropped", structuredSettings(), structuredSettings()]))
  })

  it("driftedOwnedKeys_agrees_onRandomLiveAndMergedSettings", () => {
    assertParity(Array.from({ length: 400 }, () => ["drift", structuredSettings(), structuredSettings()]))
  })
})
