import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AttributeError, describeError, errorName, pythonTypeName, RecursionError, ValueError } from "../../hooks/lib/hookkit/errors.ts";
import { trimCharacters } from "../../hooks/lib/hookkit/text.ts";

const KEEL_HOME = join(import.meta.dirname, "..", "..");

describe("hook error classes", () => {
  it("keepTheirPrintedNames_andStayDistinctBranches", () => {
    assert.equal(new ValueError("x").name, "ValueError");
    assert.equal(new RecursionError("x").name, "RecursionError");
    assert.equal(new AttributeError("x").name, "AttributeError");
    assert.equal(new RecursionError("x") instanceof ValueError, false);
    assert.equal(new AttributeError("x") instanceof ValueError, false);
    assert.equal(new ValueError("x") instanceof Error, true);
  });
});

describe("describeError", () => {
  it("printsNameAndMessage_forAnError", () => {
    assert.equal(describeError(new ValueError("bad payload")), "ValueError: bad payload");
    assert.equal(describeError(new TypeError("no good")), "TypeError: no good");
  });

  it("printsNodesSystemErrorWording_withoutAPythonClassOrErrno", () => {
    const missing = readFailure("/nonexistent/keel-file");
    assert.equal(describeError(missing), "Error: ENOENT: no such file or directory, open '/nonexistent/keel-file'");
    assert.equal(describeError(readFailure(KEEL_HOME)), "Error: EISDIR: illegal operation on a directory, read");
  });

  it("printsTheValueItself_forAThrownNonError", () => {
    assert.equal(describeError("plain text"), "plain text");
    assert.equal(describeError(7), "7");
    assert.equal(describeError(null), "null");
  });
});

describe("errorName", () => {
  it("namesTheClass_andNeverMapsAnErrnoCodeToAPythonClass", () => {
    assert.equal(errorName(new RecursionError("x")), "RecursionError");
    assert.equal(errorName(readFailure("/nonexistent/keel-file")), "Error");
    assert.equal(errorName(Object.assign(new Error("x"), { code: "EACCES" })), "Error");
  });

  it("namesAThrownNonError_asError", () => {
    assert.equal(errorName("text"), "Error");
    assert.equal(errorName(undefined), "Error");
  });
});

describe("pythonTypeName", () => {
  it("namesEachJsonValueKindTheWayTheRecordedMessagesDo", () => {
    const names = [null, true, 3, 1.5, "s", [], {}].map(pythonTypeName);
    assert.deepEqual(names, ["NoneType", "bool", "int", "float", "str", "list", "dict"]);
  });
});

describe("trimCharacters", () => {
  it("trimsOnlyTheListedCharacters_fromBothEnds", () => {
    assert.equal(trimCharacters("`'/a/b'`;", "`'\"<>;"), "/a/b");
    assert.equal(trimCharacters("\n\nline\n x\n\n", "\n"), "line\n x");
    assert.equal(trimCharacters("  keep  ", "'\""), "  keep  ");
  });

  it("returnsAnEmptyString_whenEveryCharacterIsListed", () => {
    assert.equal(trimCharacters("\n\n\n", "\n"), "");
    assert.equal(trimCharacters("", "\n"), "");
  });

  it("keepsAstralCharactersWhole", () => {
    assert.equal(trimCharacters("'\u{1F600}'", "'"), "\u{1F600}");
  });
});

describe("hook stdio", () => {
  it("readStdin_turnsCrLfAndCrIntoLf_andPrintLineAndWriteStderrKeepTheirStreams", () => {
    const script = [
      'import { printLine, readStdin, writeStderr } from "./hooks/lib/hookkit/stdio.ts";',
      "const text = readStdin();",
      "printLine(JSON.stringify(text));",
      'writeStderr("err " + text.length);',
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: KEEL_HOME, input: "a\r\nb\rc\ndé", encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '"a\\nb\\nc\\ndé"\n');
    assert.equal(result.stderr, "err 8");
  });
});

function readFailure(path: string): unknown {
  try {
    readFileSync(path);
  } catch (error) {
    return error;
  }
  throw new Error(`${path} was readable`);
}
