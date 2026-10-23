import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { skipWhitespace, valueEnd } from "../../lib/link/json_spans.ts"

const TEXT = '{"a" : [1, 2,3] , "b":"x\\"y" ,  "c": -1.5e3 }'

describe("json spans", () => {
  it("valueEnd_findsTheEndOfAnObjectArrayStringOrNumber", () => {
    const starts = [0, ...['"a"', "[1", '"b"', '"x', '"c"', "-1.5e3"].map((fragment) => TEXT.indexOf(fragment))]
    assert.deepEqual(starts.map((start) => valueEnd(TEXT, start)), [45, 4, 15, 21, 28, 35, 43])
  })

  it("valueEnd_skipsBracketsInsideStrings_andFindsLiterals", () => {
    const text = '{"k": ["]", "}\\\\", {"x": [true, null]}], "f": false}'
    assert.deepEqual([valueEnd(text, 0), valueEnd(text, text.indexOf("[")), valueEnd(text, text.indexOf("false"))], [text.length, text.indexOf(', "f"'), text.length - 1])
  })

  it("valueEnd_throwsASyntaxError_onAnUnterminatedValue", () => {
    for (const text of ['{"a": 1', '"open', "[[]", "?"]) assert.throws(() => valueEnd(text, 0), SyntaxError, text)
  })

  it("skipWhitespace_skipsOnlyJsonWhitespace", () => {
    assert.deepEqual([skipWhitespace(" \t\r\n x", 0), skipWhitespace("\u00a0x", 0), skipWhitespace("x", 0)], [5, 0, 0])
  })
})
