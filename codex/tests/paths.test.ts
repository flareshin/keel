import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { recordedAnswers, recordedPlatformMatches } from "../../tests/recorded.ts";
import { readText } from "../lib/files.ts";
import { childPath, cleanPath, isDirectory, isFile, isStrictAncestor, isSymlink, pathExists, resolvePath } from "../lib/paths.ts";
import { Refusal } from "../lib/refusal.ts";

const RECORDED_DOCUMENT = "codex-pyref";
const WELL_FORMED = [
  "", ".", "..", "/", "//", "///x", "//x//y", "a//b/./c/", "real", "real/", "real/../real/file.txt", "alias", "alias/inner", "alias/../alias",
  "relative-link", "relative-link/..", "relative-link/../file.txt", "dangling", "dangling/child", "loop-a", "loop-a/x", "nope/../real",
  "real/file.txt/child", "/nonexistent/a/b", "real/inner/../../alias/inner", "é/😀",
];
const HOST_SYMLINKED = ["/tmp/../tmp", "/private/../etc"];
const UNUSABLE = [
  "a\u0000b", "\ud800", "real/x\ud800.txt", "real/\ud800\ud801y/z", "a\udc80/b", "\udc80\ud800", "real/\udfff", "\ud800\u0000", "\u0000\ud800",
  "real/inner/../\ud800", "\udc80x", "real/\ud800\ud801",
];

interface Outcome {
  ok?: string;
  error?: string;
}

describe("path helpers", () => {
  let sandbox: string;
  const startDirectory = process.cwd();

  before(() => {
    sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-paths-")));
    mkdirSync(join(sandbox, "real/inner"), { recursive: true });
    writeFileSync(join(sandbox, "real/file.txt"), "x");
    symlinkSync(join(sandbox, "real"), join(sandbox, "alias"));
    symlinkSync("real/inner", join(sandbox, "relative-link"));
    symlinkSync(join(sandbox, "missing-target"), join(sandbox, "dangling"));
    symlinkSync("loop-b", join(sandbox, "loop-a"));
    symlinkSync("loop-a", join(sandbox, "loop-b"));
    symlinkSync(Buffer.from([0x72, 0xff]), join(sandbox, "invalid-target"));
    writeFileSync(join(sandbox, "bad.txt"), Buffer.from([0x61, 0xff, 0x62]));
    writeFileSync(join(sandbox, "crlf.txt"), "a\r\nb\rc\n");
    process.chdir(sandbox);
  });

  after(() => {
    process.chdir(startDirectory);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("resolvePath_resolvesLikePathlib_forEveryRecordedWellFormedPath", () => {
    const calls = WELL_FORMED.map((path) => ({ fn: "resolve", args: [path] }));
    const recorded = recordedAnswers<unknown, Outcome>(RECORDED_DOCUMENT, calls, { "{{CWD}}": sandbox });
    const now = WELL_FORMED.map((path) => ({ ok: resolvePath(path) }));
    assert.deepEqual(now, recorded);
  });

  it("resolvePath_resolvesLikePathlib_throughTheHostsOwnSymlinkedDirectories", { skip: recordedPlatformMatches() ? false : "/tmp and /private were recorded on darwin" }, () => {
    const calls = HOST_SYMLINKED.map((path) => ({ fn: "resolve", args: [path] }));
    const recorded = recordedAnswers<unknown, Outcome>(RECORDED_DOCUMENT, calls, { "{{CWD}}": sandbox });
    assert.deepEqual(HOST_SYMLINKED.map((path) => ({ ok: resolvePath(path) })), recorded);
  });

  it("resolvePath_followsADotDotAfterASymlinkInThePhysicalDirectory_notLexically", () => {
    assert.equal(resolvePath(`${sandbox}/relative-link/../file.txt`), join(sandbox, "real", "file.txt"));
    assert.equal(resolvePath(`${sandbox}/alias/inner/../../alias`), join(sandbox, "real"));
  });

  for (const path of UNUSABLE) {
    it(`resolvePath_refuses_aPathHoldingANulOrAnUnpairedSurrogate (${JSON.stringify(path)})`, () => {
      assert.throws(() => resolvePath(path), Refusal);
    });
  }

  it("resolvePath_refuses_aSymlinkWhoseTargetIsNotValidUtf8", () => {
    assert.throws(() => resolvePath(join(sandbox, "invalid-target")), (error: unknown) => error instanceof Error && /not valid UTF-8/.test(error.message));
    assert.throws(() => resolvePath(join(sandbox, "invalid-target", "child")), /not valid UTF-8/);
  });

  it("readText_refusesAnyInvalidByte_keepsTheByteOrderMark_andTranslatesNewlines", () => {
    assert.throws(() => readText(join(sandbox, "bad.txt")), /not valid UTF-8/);
    assert.equal(readText(join(sandbox, "crlf.txt")), "a\nb\nc\n");
    writeFileSync(join(sandbox, "bom.txt"), "﻿a");
    assert.equal(readText(join(sandbox, "bom.txt")), "﻿a");
    assert.throws(() => readText(join(sandbox, "a\u0000b")), Refusal);
    assert.throws(() => readText(join(sandbox, "\ud800")), Refusal);
  });

  it("pathExists_isFalse_forAPathHoldingANulOrAnUnpairedSurrogate_insteadOfThrowing", () => {
    for (const path of ["a\u0000b", `${sandbox}/real/file.txt\u0000`, "\ud800", `${sandbox}/real\udc80`]) {
      assert.deepEqual([pathExists(path), isFile(path), isDirectory(path), isSymlink(path)], [false, false, false, false], JSON.stringify(path));
    }
  });

  it("cleanPath_dropsEmptyAndDotParts_keepsDotDot_andAnExactDoubleSlashRoot", () => {
    assert.deepEqual(["", ".", "a//b/./c/", "/a/../b", "//x", "///x", "a/.."].map(cleanPath), [".", ".", "a/b/c", "/a/../b", "//x", "/x", "a/.."]);
  });

  it("childPath_joinsRelativeNames_andLetsAnAbsoluteNameReplaceTheParent", () => {
    assert.deepEqual([childPath("/p", "a/../b"), childPath("/p", "/q/r"), childPath("/p", "")], ["/p/a/../b", "/q/r", "/p"]);
  });

  it("isStrictAncestor_isFalseForTheSamePath_andForASiblingWithTheSamePrefix", () => {
    assert.deepEqual([isStrictAncestor("/a", "/a/b"), isStrictAncestor("/a", "/a"), isStrictAncestor("/a", "/ab"), isStrictAncestor("/", "/a")], [true, false, false, true]);
  });
});
