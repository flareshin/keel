import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_JSON_DEPTH } from "../../hooks/lib/hookkit/json.ts";
import { dumpsAscii, pythonJsonDumps, pythonStr } from "../../hooks/lib/hookkit/pycompat.ts";
import { describeError, pythonErrorName, RecursionError, ValueError } from "../../hooks/lib/hookkit/pyruntime.ts";

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
      for (const render of [pythonJsonDumps, dumpsAscii, pythonStr, (value: unknown) => pythonStr([value])]) {
        assert.throws(() => render(arrays), (error: Error) => error instanceof RecursionError && !(error instanceof ValueError), `${depth}`);
      }
    }
    assert.doesNotThrow(() => pythonJsonDumps(loadsDeep(MAX_JSON_DEPTH)));
    assert.doesNotThrow(() => pythonStr(loadsDeep(MAX_JSON_DEPTH)));
  });

  it("pythonStr_rendersDeepListsAndDicts_asPythonDoes", () => {
    for (const depth of DEEP_LEVELS) {
      assert.equal(pythonStr(loadsDeep(depth)), nestedArrays(depth), `${depth}`);
      assert.equal(pythonStr(JSON.parse(`{"k": ${nestedArrays(depth)}}`)), `{'k': ${nestedArrays(depth)}}`, `${depth}`);
    }
    assert.equal(pythonStr(JSON.parse(nestedObjects(3000))), "{'a': ".repeat(3000) + "1" + "}".repeat(3000));
    const sample = [["x", null, true, 1.5, NaN, Infinity], { k: "it's" }, ["a'b\"c"], {}, []];
    assert.equal(pythonStr(sample), `[['x', None, True, 1.5, nan, inf], {'k': "it's"}, ['a\\'b"c'], {}, []]`);
  });

  it("pythonStr_printsEllipsis_forAContainerThatHoldsItself", () => {
    const list: unknown[] = [];
    list.push(list);
    const dict: Record<string, unknown> = {};
    dict["a"] = dict;
    assert.equal(pythonStr(list), "[[...]]");
    assert.equal(pythonStr([list]), "[[[...]]]");
    assert.equal(pythonStr(dict), "{'a': {...}}");
    assert.equal(pythonStr({ k: [dict] }), "{'k': [{'a': {...}}]}");
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

describe("pyruntime", () => {
  it("describeError_spellsPythonsOsErrorClassAndMessage", () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/nonexistent/f'"), { code: "ENOENT", path: "/nonexistent/f" });
    assert.equal(describeError(missing), "FileNotFoundError: [Errno 2] No such file or directory: '/nonexistent/f'");
    const exists = Object.assign(new Error("EEXIST"), { code: "EEXIST", path: "/data/handoff" });
    assert.equal(describeError(exists), "FileExistsError: [Errno 17] File exists: '/data/handoff'");
  });

  it("pythonErrorName_mapsErrnoCodesAndKeepsOwnClassNames", () => {
    assert.equal(pythonErrorName(Object.assign(new Error("x"), { code: "EACCES" })), "PermissionError");
    assert.equal(pythonErrorName(Object.assign(new Error("x"), { code: "EISDIR" })), "IsADirectoryError");
    assert.equal(pythonErrorName(Object.assign(new Error("x"), { code: "ENOTDIR" })), "NotADirectoryError");
    assert.equal(pythonErrorName(new ValueError("v")), "ValueError");
    assert.equal(describeError(new ValueError("v")), "ValueError: v");
  });
});
