import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonSyntaxError, NonFiniteJsonNumber, parseFiniteJson, parseJson, parseJsonReadingNonFiniteNumbersAsZero, parsePayload, parseTranscriptLine } from "../../hooks/lib/hookkit/json.ts";
import { MAX_JSON_DEPTH } from "../../hooks/lib/hookkit/pycompat.ts";
import { RecursionError, ValueError } from "../../hooks/lib/hookkit/pyruntime.ts";

function nestedArrays(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

describe("json module", () => {
  it("loads_whenTheRuntimeModuleIsImportedFirst", () => {
    const script = 'await import("./hooks/lib/hookkit/pyruntime.ts"); await import("./hooks/lib/hookkit/json.ts");';
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe("parseJson", () => {
  it("parseJson_readsADocument_nestedExactlyToTheLimit", () => {
    assert.equal(MAX_JSON_DEPTH, 10000);
    assert.doesNotThrow(() => parseJson(nestedArrays(MAX_JSON_DEPTH)));
    assert.doesNotThrow(() => parseJson('{"a":'.repeat(MAX_JSON_DEPTH) + "1" + "}".repeat(MAX_JSON_DEPTH)));
  });

  it("parseJson_throwsRecursionError_whenNestedOneLevelPastTheLimit", () => {
    assert.throws(() => parseJson(nestedArrays(MAX_JSON_DEPTH + 1)), RecursionError);
    assert.throws(() => parseJson('{"a":'.repeat(MAX_JSON_DEPTH + 1) + "1" + "}".repeat(MAX_JSON_DEPTH + 1)), RecursionError);
  });

  it("parseJson_throwsRecursionError_whenTooDeepTextIsAlsoMalformed", () => {
    assert.throws(() => parseJson("[".repeat(MAX_JSON_DEPTH + 1)), RecursionError);
  });

  it("parseJson_ignoresBracketsInsideStrings_whenCountingDepth", () => {
    const text = JSON.stringify(["[".repeat(MAX_JSON_DEPTH + 1), '\\"[[', "{".repeat(MAX_JSON_DEPTH + 1)]);
    assert.equal((parseJson(text) as string[]).length, 3);
  });

  it("parseJson_throwsJsonSyntaxError_asAValueError_forMalformedText", () => {
    for (const text of ["", "{", "[1,]", "﻿{}", "NaN", "[Infinity]", "{'a': 1}"]) {
      assert.throws(() => parseJson(text), (error: unknown) => error instanceof JsonSyntaxError && error instanceof ValueError, JSON.stringify(text));
    }
  });

  it("parseJson_readsIntegersPastPythonsDigitLimit", () => {
    assert.equal(parseJson("1".repeat(4301)), Infinity);
    assert.equal(parseJson("1".repeat(300)), Number("1".repeat(300)));
  });

  it("parseJson_keepsAProtoKeyAsAnOwnMember", () => {
    const parsed = parseJson('{"__proto__": {"polluted": 1}}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["__proto__"]);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});

describe("parsePayload", () => {
  it("parsePayload_throwsValueError_whenTheDocumentIsNotAnObject", () => {
    for (const text of ["[]", "1", '"x"', "null"]) assert.throws(() => parsePayload(text), ValueError, text);
    assert.deepEqual(parsePayload('{"a": 1}'), { a: 1 });
  });
});

describe("parseFiniteJson", () => {
  it("parseFiniteJson_throwsJsonSyntaxError_whenANumberIsPastTheDoubleRange", () => {
    for (const text of ["1e400", "[1, -1e400]", `{"a": {"b": [${"9".repeat(400)}]}}`]) assert.throws(() => parseFiniteJson(text), JsonSyntaxError, text.slice(0, 20));
    assert.deepEqual(parseFiniteJson(`{"a": [1.5, ${"9".repeat(300)}]}`), { a: [1.5, Number("9".repeat(300))] });
  });

  it("parseFiniteJson_walksADocumentNestedToTheLimit", () => {
    assert.doesNotThrow(() => parseFiniteJson(nestedArrays(MAX_JSON_DEPTH)));
  });

  it("parseFiniteJson_walksAWideArray", () => {
    assert.equal((parseFiniteJson("[" + "1,".repeat(200_000) + "1]") as number[]).length, 200_001);
  });
});

describe("parseJsonReadingNonFiniteNumbersAsZero", () => {
  it("readsNonFiniteValuesAsZero_andLeavesStringsAndValidJsonAlone", () => {
    assert.deepEqual(parseJsonReadingNonFiniteNumbersAsZero('{"a": NaN, "b": [Infinity, -Infinity], "c": "NaN", "d\\u0041": true}'), { a: 0, b: [0, 0], c: "NaN", dA: true });
    assert.deepEqual(parseJsonReadingNonFiniteNumbersAsZero('{"a": 1.5}'), { a: 1.5 });
  });

  it("throwsJsonSyntaxError_whenTheTextIsMalformedAnyway", () => {
    for (const text of ['{"a": NaNx}', '{NaN: 1}', '{"a": 1 NaN}', '{"a": NaN.5}', '{"a": NaNe5}', '[Infinity0]']) assert.throws(() => parseJsonReadingNonFiniteNumbersAsZero(text), JsonSyntaxError, text);
  });
});

describe("parseTranscriptLine", () => {
  it("parseTranscriptLine_throwsNonFiniteJsonNumber_whenOnlyANonFiniteValueBreaksTheLine", () => {
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      for (const text of [`{"a": ${literal}}`, `[1, ${literal}]`, `{"a":[${literal}]}`, `[${literal} ]`, `{"a": ${literal}\n}`, literal]) {
        assert.throws(() => parseTranscriptLine(text), (error: unknown) => error instanceof NonFiniteJsonNumber && !(error instanceof ValueError), text);
      }
    }
  });

  it("parseTranscriptLine_throwsJsonSyntaxError_whenTheLineIsMalformedAnyway", () => {
    for (const text of ['{"a": NaN', '{"a": NaNx}', '{"a": 1 NaN}', '{NaN: 1}', "not json", '{"a": NaN.5}', '{"a": NaNe5}', '[Infinity0]']) {
      assert.throws(() => parseTranscriptLine(text), JsonSyntaxError, text);
    }
  });

  it("parseTranscriptLine_readsNonFiniteWordsInsideStrings", () => {
    assert.deepEqual(parseTranscriptLine('{"a": "NaN", "b": "x\\" Infinity"}'), { a: "NaN", b: 'x" Infinity' });
  });

  it("parseTranscriptLine_throwsRecursionError_whenTooDeep", () => {
    assert.throws(() => parseTranscriptLine(nestedArrays(MAX_JSON_DEPTH + 1)), RecursionError);
  });
});
