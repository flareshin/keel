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
