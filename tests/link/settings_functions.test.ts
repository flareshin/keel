import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { driftedOwnedKeys, listDroppedItems, spliceOwnedKeys } from "../../lib/link/settings_json.ts"
import { errorName } from "../../measure/lib/measurekit/cli.ts"
import type { JsonObject } from "../../measure/lib/measurekit/json.ts"

type Case = [string, string, string]
type Operation = "splice" | "dropped" | "drift"

const RECORDED_RESULTS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "link", "settings-functions.json"), "utf8")) as Record<Operation, unknown[]>
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|NaN|-?Infinity/g

const TRICKY_CHARS = ["a", "Z", " ", "\t", "\n", "\u0000", "\u001f", "\u007f", "\u00e9", "\u2028", "\u{1F600}", "\\", '"', "/", "{", "}", ",", ":", "[", "]"]
const NUMBER_TEXTS = ["0", "-1", "42", "1.0", "2.5", "-0.0", "1e3", "1E-7", "0.1", "12345678901234567890", "12345678901234567890.5", "1e400"]
const WHITESPACE = ["", " ", "\n", "\t", "\n  ", "\n    ", "  "]
const OWNED_KEYS = ["hooks", "permissions", "env"]
const MEMBER_KEYS = [...OWNED_KEYS, "model", "theme", "nested", "\u00e9", "10", "2"]
const STRING_POOL = ["Read", "Bash(x:*)", "\u00e9", "\u{1F600}", "a b", "Glob"]
const PERMISSION_KEYS = ["allow", "deny", "ask", "defaultMode", "extra"]


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
    if (operation === "splice") return spliceOwnedKeys(first, JSON.parse(second) as JsonObject)
    const live = JSON.parse(first) as JsonObject
    const merged = JSON.parse(second) as JsonObject
    if (operation === "dropped") return listDroppedItems(live, merged)
    return driftedOwnedKeys({ path: "settings.json", text: first, values: live }, merged)
  } catch (error) {
    return `ERR ${errorName(error)}: ${(error as Error).message}`
  }
}

function numberAndEscapeNeutral(value: unknown): unknown {
  if (typeof value === "string") return value.replace(JSON_TOKEN, (token) => (token.startsWith('"') ? JSON.stringify(JSON.parse(token)) : JSON.stringify(Number(token))))
  return Array.isArray(value) ? value.map(numberAndEscapeNeutral) : value
}

function assertRecordedResults(cases: Case[], recordedCount: number): void {
  const recorded = RECORDED_RESULTS[cases[0]?.[0] as Operation]
  assert.equal(recorded.length, cases.length)
  const compared = cases.flatMap(([operation, first, second], index) => {
    const expected = recorded[index]
    if (expected === null) return []
    const actual = typescriptResult(operation, first, second)
    return [{ operation, first, second, expected: numberAndEscapeNeutral(expected), actual: numberAndEscapeNeutral(actual) }]
  })
  assert.equal(compared.length, recordedCount)
  const bad = compared.filter((entry) => JSON.stringify(entry.actual) !== JSON.stringify(entry.expected))
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} mismatches`)
}

describe("link settings functions keep the recorded results on random settings", () => {
  it("spliceOwnedKeys_keepsTheRecordedResults_onRandomTopLevelObjectsAndMerges", () => {
    const cases: Case[] = Array.from({ length: 500 }, () => {
      const members = Array.from({ length: Math.floor(random() * 6) }, () => `${whitespace()}${JSON.stringify(pick(MEMBER_KEYS))}${whitespace()}:${whitespace()}${randomJson(1)}${whitespace()}`)
      return ["splice", `${whitespace()}{${members.join(",")}${whitespace()}}${pick(["", "\n"])}`, randomMerged()]
    })
    assertRecordedResults(cases, 485)
  })

  it("listDroppedItems_keepsTheRecordedResults_onRandomLiveAndMergedSettings", () => {
    assertRecordedResults(Array.from({ length: 400 }, () => ["dropped", structuredSettings(), structuredSettings()]), 389)
  })

  it("driftedOwnedKeys_keepsTheRecordedResults_onRandomLiveAndMergedSettings", () => {
    assertRecordedResults(Array.from({ length: 400 }, () => ["drift", structuredSettings(), structuredSettings()]), 340)
  })
})

describe("link settings functions on values the recordings did not keep", () => {
  const live = (permissions: string): JsonObject => JSON.parse(`{"permissions": ${permissions}}`) as JsonObject

  it("driftedOwnedKeys_countsANonListPermissionValueAsNoItems_insteadOfFailing", () => {
    const merged = live('{"allow": ["Read"]}')
    assert.deepEqual(driftedOwnedKeys({ path: "settings.json", text: "", values: live('{"allow": "Read"}') }, merged), ["permissions.allow: live=0 merged=1 only_live=0 only_merged=1"])
    assert.deepEqual(driftedOwnedKeys({ path: "settings.json", text: "", values: live('{"allow": 7}') }, merged), ["permissions.allow: live=0 merged=1 only_live=0 only_merged=1"])
  })

  it("listDroppedItems_dropsEveryLiveListItem_whenTheMergedValueIsNotAList", () => {
    assert.deepEqual(listDroppedItems(live('{"allow": ["Read", "Glob"]}'), live('{"allow": 7}')), ["permissions.allow Glob", "permissions.allow Read"])
  })

  it("spliceOwnedKeys_writesIntegerLikeKeysOfAnOwnedValueFirst", () => {
    assert.equal(spliceOwnedKeys("{}", JSON.parse('{"env": {"b": "1", "2": "2"}}') as JsonObject), '{\n  "env": {\n    "2": "2",\n    "b": "1"\n  }\n}')
  })
})
