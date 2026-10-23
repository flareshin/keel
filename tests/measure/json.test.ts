import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseJsonKeepingIntegers, stringifySorted } from "../../measure/lib/measurekit/json.ts"

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
})
