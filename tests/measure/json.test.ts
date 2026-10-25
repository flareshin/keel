import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { MAX_JSON_DEPTH, nestsPastMaxJsonDepth, parseJsonKeepingIntegers, stringifySorted } from "../../measure/lib/measurekit/json.ts"

const MIXED_KEYS = { "\u{1F600}": 1, "\uffff": 2, b: 3, "": 4 }

describe("json", () => {
  it("stringifySorted_sortsKeysByCodePoint_compactAndIndented", () => {
    assert.equal(stringifySorted(MIXED_KEYS), '{"":4,"b":3,"\uffff":2,"\u{1F600}":1}')
    assert.equal(stringifySorted({ z: [1, { y: null, x: "s" }], a: {} }, 2), '{\n  "a": {},\n  "z": [\n    1,\n    {\n      "x": "s",\n      "y": null\n    }\n  ]\n}')
  })

  it("stringifySorted_dropsUndefinedMembers_likeJsonStringify", () => {
    assert.equal(stringifySorted({ a: undefined, b: [undefined] }), '{"b":[null]}')
  })

  it("parseJsonKeepingIntegers_keepsIntegersBeyondDoublePrecision_andLeavesOtherNumbers", () => {
    const parsed = parseJsonKeepingIntegers('{"big": 12345678901234567890, "small": 7, "float": 1.5}')
    assert.equal(JSON.stringify(parsed), '{"big":12345678901234567890,"small":7,"float":1.5}')
    assert.equal(stringifySorted(parsed), '{"big":12345678901234567890,"float":1.5,"small":7}')
  })

  it("parseJsonKeepingIntegers_readsADocumentNestedToTheDepthBound", () => {
    const nested = "[".repeat(MAX_JSON_DEPTH) + "1.5" + "]".repeat(MAX_JSON_DEPTH)
    assert.doesNotThrow(() => parseJsonKeepingIntegers(nested))
    assert.equal(stringifySorted(parseJsonKeepingIntegers('[[1e20, -9007199254740993, 9007199254740991]]')), "[[100000000000000000000,-9007199254740993,9007199254740991]]")
  })

  it("stringifySorted_writesADocumentNestedToTheDepthBound", () => {
    const nested = "[".repeat(MAX_JSON_DEPTH) + "]".repeat(MAX_JSON_DEPTH)
    assert.equal(stringifySorted(JSON.parse(nested)), nested)
    const objects = '{"b":'.repeat(MAX_JSON_DEPTH - 1) + "[]" + "}".repeat(MAX_JSON_DEPTH - 1)
    const indented = stringifySorted(JSON.parse(objects), 1)
    assert.ok(indented.startsWith('{\n "b": {\n  "b": {\n'), indented.slice(0, 40))
    assert.equal(stringifySorted(JSON.parse(indented)), objects)
  })

  it("stringifySorted_skipsUnwritableMembers_andWritesThemAsNullInArrays", () => {
    assert.equal(stringifySorted({ b: undefined, a: [undefined, () => 1, 2], c: {} }), '{"a":[null,null,2],"c":{}}')
    assert.equal(stringifySorted({ a: [], b: { c: [1] } }, 2), '{\n  "a": [],\n  "b": {\n    "c": [\n      1\n    ]\n  }\n}')
    assert.equal(stringifySorted(undefined), "null")
  })

  it("parseJsonKeepingIntegers_readsAWideArray", () => {
    assert.equal((parseJsonKeepingIntegers("[" + "1,".repeat(200_000) + "9007199254740993]") as unknown[]).length, 200_001)
  })

  it("nestsPastMaxJsonDepth_countsBracketsOutsideStringsOnly", () => {
    assert.equal(MAX_JSON_DEPTH, 10000)
    assert.equal(nestsPastMaxJsonDepth("[".repeat(MAX_JSON_DEPTH) + "]".repeat(MAX_JSON_DEPTH)), false)
    assert.equal(nestsPastMaxJsonDepth("{\"a\":".repeat(MAX_JSON_DEPTH + 1)), true)
    assert.equal(nestsPastMaxJsonDepth(JSON.stringify(["[".repeat(MAX_JSON_DEPTH + 1), '\\"[[', "{".repeat(MAX_JSON_DEPTH + 1)])), false)
  })
})
