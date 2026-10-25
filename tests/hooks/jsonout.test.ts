import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dumpsAscii, pythonJsonDumps } from "../../hooks/lib/hookkit/jsonout.ts";
import { MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts";
import { RecursionError, ValueError } from "../../hooks/lib/hookkit/errors.ts";

const DEEP_LEVELS = [3000, 9999];
const PAST_THE_BOUND = [10001, 140000, 1000000];

function nestedArrays(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function nestedObjects(depth: number): string {
  return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
}

function loadsDeep(depth: number): unknown {
  let value: unknown[] = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
}

describe("dumpsAscii", () => {
  it("escapesNonAsciiDeleteAndSurrogatePairs_asPythonDoes", () => {
    const value = { a: ["é", "\u{1F600}", "\x7f", "x\ny"], b: { c: null, d: 1.5 } };
    assert.equal(
      dumpsAscii(value),
      '{"a": ["\\u00e9", "\\ud83d\\ude00", "\\u007f", "x\\ny"], "b": {"c": null, "d": 1.5}}',
    );
  });

  it("writesNonFiniteNumbers_asPythonDoes", () => {
    const text = '{"a": NaN, "b": [Infinity, -Infinity], "c": 1.5}';
    const value = { a: NaN, b: [Infinity, -Infinity], c: 1.5 };
    assert.equal(dumpsAscii(value), text);
    assert.equal(pythonJsonDumps(value), text);
  });

  it("writesDeeplyNestedValues_asPythonDoes", () => {
    for (const depth of DEEP_LEVELS) {
      assert.equal(pythonJsonDumps(JSON.parse(nestedArrays(depth))), nestedArrays(depth));
      assert.equal(dumpsAscii(JSON.parse(nestedArrays(depth))), nestedArrays(depth));
    }
    assert.equal(pythonJsonDumps(JSON.parse(nestedObjects(3000))), '{"a": '.repeat(3000) + "1" + "}".repeat(3000));
    assert.equal(pythonJsonDumps({ k: [{}, [], { a: [1, { b: null }] }] }), '{"k": [{}, [], {"a": [1, {"b": null}]}]}');
  });

  it("dumpsAndRendersPastTheDepthBound_throwRecursionErrors_thatAreNotValueErrors", () => {
    for (const depth of PAST_THE_BOUND) {
      const arrays = loadsDeep(depth);
      for (const render of [pythonJsonDumps, dumpsAscii]) {
        assert.throws(() => render(arrays), (error: Error) => error instanceof RecursionError && !(error instanceof ValueError), `${depth}`);
      }
    }
    assert.doesNotThrow(() => pythonJsonDumps(loadsDeep(MAX_JSON_DEPTH)));
  });

  it("raisesValueError_forAContainerThatHoldsItself", () => {
    const loop: unknown[] = [];
    loop.push({ inner: loop });
    assert.throws(() => pythonJsonDumps(loop), (error: Error) => error instanceof ValueError && error.message === "Circular reference detected");
  });

  it("keepsNonAsciiText_unlessAsked", () => {
    assert.equal(pythonJsonDumps({ k: "é" }), '{"k": "é"}');
  });
});
