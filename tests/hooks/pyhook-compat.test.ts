import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { pythonJsonDumps } from "../../hooks/lib/hookkit/pycompat.ts";
import { fnmatchCase } from "../../hooks/lib/hookkit/pyfnmatch.ts";
import { dumpsAscii, JSONDecodeError, loads, parsePayload } from "../../hooks/lib/hookkit/pyjson.ts";
import { dirname, readTextFile, realpath, shlexQuote } from "../../hooks/lib/hookkit/pypath.ts";
import { describeError, pythonErrorName, ValueError } from "../../hooks/lib/hookkit/pyruntime.ts";
import { Sandbox } from "./helpers.ts";

function decodeFailure(text: string): string {
  try {
    loads(text);
  } catch (error) {
    assert.ok(error instanceof JSONDecodeError, String(error));
    return error.message;
  }
  throw new Error(`${JSON.stringify(text)} decoded`);
}

const DIGIT_LIMIT_MESSAGE = "Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit";
const AT_LIMIT = "1".repeat(4300);
const OVER_LIMIT = "1".repeat(4301);
const DEEP_LEVELS = [3000, 100000];

function valueErrorMessage(text: string): string {
  try {
    loads(text);
  } catch (error) {
    assert.ok(error instanceof ValueError && !(error instanceof JSONDecodeError), String(error));
    return error.message;
  }
  throw new Error(`${text.slice(0, 40)} decoded`);
}

function nestedArrays(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function nestedObjects(depth: number): string {
  return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
}

function depthOf(value: unknown, child: (node: unknown) => unknown): number {
  let depth = 0;
  for (let node = value; node !== undefined; node = child(node)) depth += 1;
  return depth;
}

describe("pyjson", () => {
  it("loads_reportsPythonsMessageAndPosition_forEachKindOfSyntaxError", () => {
    const expected: Array<[string, string]> = [
      ['"a\\xb"', "Invalid \\escape: line 1 column 3 (char 2)"],
      ['"a\nb"', "Invalid control character at: line 1 column 3 (char 2)"],
      ['"abc', "Unterminated string starting at: line 1 column 1 (char 0)"],
      ['"\\u12', "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
      ['"\\ud800\\u12"', "Invalid \\uXXXX escape: line 1 column 9 (char 8)"],
      ['{"a":1,}', "Illegal trailing comma before end of object: line 1 column 7 (char 6)"],
      ["[1,]", "Illegal trailing comma before end of array: line 1 column 3 (char 2)"],
      ['{"a"}', "Expecting ':' delimiter: line 1 column 5 (char 4)"],
      ["{", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
      ["[", "Expecting value: line 1 column 2 (char 1)"],
      ["nul", "Expecting value: line 1 column 1 (char 0)"],
      ["01", "Extra data: line 1 column 2 (char 1)"],
      ['{"a":1 "b":2}', "Expecting ',' delimiter: line 1 column 8 (char 7)"],
      ["", "Expecting value: line 1 column 1 (char 0)"],
      ["\ufeff{}", "Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)"],
      ['{"tool_input": {"command": "git push"', "Expecting ',' delimiter: line 1 column 38 (char 37)"],
    ];
    for (const [text, message] of expected) assert.equal(decodeFailure(text), message, JSON.stringify(text));
  });

  it("loads_returnsNonFiniteNumbers_forTheLiteralsPythonAccepts", () => {
    const parsed = loads('{"a": [NaN, Infinity, -Infinity], "b": NaN}') as { a: number[]; b: number };
    assert.ok(Number.isNaN(parsed.b));
    assert.ok(Number.isNaN(parsed.a[0]));
    assert.deepEqual(parsed.a.slice(1), [Infinity, -Infinity]);
    assert.equal(decodeFailure("NaNx"), "Extra data: line 1 column 4 (char 3)");
    assert.equal(decodeFailure("Infinit"), "Expecting value: line 1 column 1 (char 0)");
    assert.equal(decodeFailure("{NaN: 1}"), "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)");
  });

  it("loads_keepsDuplicateAndPrototypeKeysAsOwnMembers", () => {
    assert.deepEqual(Object.entries(loads('{"a": 1, "b": 2, "a": 3}') as object), [["a", 3], ["b", 2]]);
    assert.deepEqual(Object.keys(loads('{"__proto__": {"x": 1}}') as object), ["__proto__"]);
  });

  it("loads_countsPositionsInCodePointsAndLinesInNewlines", () => {
    assert.equal(decodeFailure('"\u{1F600}\u{1F600}" x'), "Extra data: line 1 column 6 (char 5)");
    assert.equal(decodeFailure('{"a":\n  1,\n  }'), "Illegal trailing comma before end of object: line 2 column 4 (char 9)");
  });

  it("loads_returnsTheValue_whenTheTextIsValid", () => {
    assert.deepEqual(loads(' {"a": [1, 2.5, null, true], "b": {"c": "\\u00e9"}}\n'), { a: [1, 2.5, null, true], b: { c: "é" } });
  });

  it("loads_acceptsIntegersUpToTheDigitLimit_withOrWithoutASign", () => {
    assert.doesNotThrow(() => loads(AT_LIMIT));
    assert.doesNotThrow(() => loads("-" + AT_LIMIT));
    assert.doesNotThrow(() => loads(`{"n": ${AT_LIMIT}}`));
  });

  it("loads_raisesPythonsValueError_forIntegersOverTheDigitLimit_notCountingTheSign", () => {
    for (const text of [OVER_LIMIT, "-" + OVER_LIMIT, `[${OVER_LIMIT}]`, `{"n": ${OVER_LIMIT}}`, `${OVER_LIMIT}x`, `[${OVER_LIMIT},]`]) {
      assert.equal(valueErrorMessage(text), DIGIT_LIMIT_MESSAGE, text.slice(0, 20));
    }
  });

  it("loads_reportsTheSyntaxErrorThatComesFirst_whenAnOverLimitIntegerFollows", () => {
    assert.equal(decodeFailure(`[,${OVER_LIMIT}]`), "Expecting value: line 1 column 2 (char 1)");
    assert.equal(decodeFailure(`0${OVER_LIMIT}`), "Extra data: line 1 column 2 (char 1)");
  });

  it("loads_keepsLongNumbersWithFractionOrExponentAsFloats_andLongStringsAsText", () => {
    for (const spelling of [`${OVER_LIMIT}.5`, `-${OVER_LIMIT}.5`, `${OVER_LIMIT}e0`, `${OVER_LIMIT}E+0`, `${OVER_LIMIT}.0e-1`]) {
      assert.equal(typeof loads(spelling), "number", spelling.slice(-8));
    }
    assert.equal(loads(`"${OVER_LIMIT}"`), OVER_LIMIT);
  });

  it("loads_parsesNestedArraysAndObjects_atAnyDepthPythonParses", () => {
    for (const depth of DEEP_LEVELS) {
      assert.equal(depthOf(loads(nestedArrays(depth)), (node) => (node as unknown[])[0]), depth, `arrays ${depth}`);
      assert.equal(depthOf(loads(nestedObjects(depth)), (node) => (node as Record<string, unknown>)["a"]), depth + 1, `objects ${depth}`);
    }
  });

  it("loads_reportsPythonsPosition_forSyntaxErrorsInDeeplyNestedText", () => {
    assert.equal(decodeFailure("[".repeat(3000)), "Expecting value: line 1 column 3001 (char 3000)");
    assert.equal(decodeFailure("[".repeat(3000) + "]".repeat(2999)), "Expecting ',' delimiter: line 1 column 6000 (char 5999)");
    assert.equal(decodeFailure(nestedArrays(3000) + "x"), "Extra data: line 1 column 6001 (char 6000)");
    assert.equal(decodeFailure('{"a":'.repeat(3000)), "Expecting value: line 1 column 15001 (char 15000)");
    assert.equal(decodeFailure("[".repeat(100000)), "Expecting value: line 1 column 100001 (char 100000)");
    assert.equal(decodeFailure("[".repeat(100000) + "]".repeat(99999)), "Expecting ',' delimiter: line 1 column 200000 (char 199999)");
    assert.equal(decodeFailure(nestedArrays(100000) + "x"), "Extra data: line 1 column 200001 (char 200000)");
    assert.equal(decodeFailure('{"a":'.repeat(100000)), "Expecting value: line 1 column 500001 (char 500000)");
    assert.equal(decodeFailure(nestedObjects(100000).slice(0, -1)), "Expecting ',' delimiter: line 1 column 600001 (char 600000)");
  });

  it("parsePayload_readsAnObjectWithADeepMember_andRaisesValueErrorForAnOverLimitMember", () => {
    const payload = parsePayload(`{"tool_name": "Bash", "deep": ${nestedArrays(3000)}, "tail": 1}`);
    assert.equal(payload["tool_name"], "Bash");
    assert.equal(payload["tail"], 1);
    assert.equal(valueErrorMessage(`{"tool_name": "Bash", "n": ${OVER_LIMIT}}`), DIGIT_LIMIT_MESSAGE);
    assert.equal(valueErrorMessage(`{"a": 1, "deep": ${nestedArrays(3000)}, "n": ${OVER_LIMIT}}`), DIGIT_LIMIT_MESSAGE);
  });

  it("parsePayload_raisesValueError_whenTheDocumentIsNotAnObject", () => {
    assert.throws(() => parsePayload("[1]"), (error: Error) => error instanceof ValueError && error.message === "hook payload is not a JSON object");
  });
});

describe("dumpsAscii", () => {
  it("escapesNonAsciiDeleteAndSurrogatePairs_asPythonDoes", () => {
    const value = { a: ["é", "\u{1F600}", "\x7f", "x\ny"], b: { c: null, d: 1.5 } };
    assert.equal(
      dumpsAscii(value),
      '{"a": ["\\u00e9", "\\ud83d\\ude00", "\\u007f", "x\\ny"], "b": {"c": null, "d": 1.5}}',
    );
  });

  it("writesNonFiniteNumbers_asPythonDoes_andRoundTripsThem", () => {
    const text = '{"a": NaN, "b": [Infinity, -Infinity], "c": 1.5}';
    assert.equal(dumpsAscii(loads(text)), text);
    assert.equal(pythonJsonDumps(loads(text)), text);
  });

  it("writesDeeplyNestedValues_asPythonDoes", () => {
    for (const depth of DEEP_LEVELS) {
      assert.equal(pythonJsonDumps(loads(nestedArrays(depth))), nestedArrays(depth));
      assert.equal(dumpsAscii(loads(nestedArrays(depth))), nestedArrays(depth));
    }
    assert.equal(pythonJsonDumps(loads(nestedObjects(3000))), '{"a": '.repeat(3000) + "1" + "}".repeat(3000));
    assert.equal(pythonJsonDumps({ k: [{}, [], { a: [1, { b: null }] }] }), '{"k": [{}, [], {"a": [1, {"b": null}]}]}');
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

describe("pyfnmatch", () => {
  it("fnmatchCase_letsStarCrossSlashesAndIsCaseSensitive", () => {
    assert.equal(fnmatchCase("db/patch.sql", "*.sql"), true);
    assert.equal(fnmatchCase("a/b", "a*"), true);
    assert.equal(fnmatchCase("A", "a"), false);
  });

  it("fnmatchCase_readsBracketsLikePython", () => {
    const cases: Array<[string, string, boolean]> = [
      ["x[", "x[", true], ["b", "[a-c]", true], ["d", "[!a-c]", true], ["b", "[!a-c]", false], ["]", "[]]", true],
      ["-", "[a-]", true], ["c", "[c-a]", false], ["a", "[]", false], ["\u{1F600}", "?", true],
    ];
    for (const [name, pattern, expected] of cases) assert.equal(fnmatchCase(name, pattern), expected, `${name} ~ ${pattern}`);
  });
});

describe("pypath", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox();
  });

  afterEach(() => {
    sandbox.close();
  });

  it("dirname_dropsTrailingSlashesUnlessTheHeadIsAllSlashes", () => {
    const cases: Array<[string, string]> = [["/a/b/", "/a/b"], ["/a", "/"], ["a", ""], ["//a//b//c", "//a//b"], ["/", "/"]];
    for (const [path, expected] of cases) assert.equal(dirname(path), expected, path);
  });

  it("realpath_resolvesSymlinksAndKeepsTheMissingTail", () => {
    const real = join(sandbox.root, "real");
    mkdirSync(real);
    symlinkSync(real, join(sandbox.root, "link"));
    assert.equal(realpath(join(sandbox.root, "link", "x", "..", "y", "z")), join(real, "y", "z"));
  });

  it("shlexQuote_quotesWhatTheShellWouldSplit", () => {
    const cases: Array<[string, string]> = [["a b", "'a b'"], ["", "''"], ["it's", `'it'"'"'s'`], ["a/b-c.d=e", "a/b-c.d=e"], ["é", "'é'"]];
    for (const [text, expected] of cases) assert.equal(shlexQuote(text), expected, text);
  });

  it("readTextFile_translatesNewlinesAndNamesTheMissingPath", () => {
    const path = join(sandbox.root, "crlf.txt");
    writeFileSync(path, "a\r\nb\rc\n");
    assert.equal(readTextFile(path), "a\nb\nc\n");
    assert.throws(() => readTextFile(join(sandbox.root, "absent")), (error: NodeJS.ErrnoException) => error.path === join(sandbox.root, "absent"));
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
