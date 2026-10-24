import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { delimiter, join } from "node:path";
import { missingFields } from "../../hooks/lib/hookkit/contract.ts";
import * as env from "../../hooks/lib/hookkit/env.ts";
import { FireLog } from "../../hooks/lib/hookkit/fires.ts";
import * as protocol from "../../hooks/lib/hookkit/protocol.ts";
import { JsonSyntaxError, parsePayload } from "../../hooks/lib/hookkit/json.ts";
import { RecursionError, ValueError } from "../../hooks/lib/hookkit/pyruntime.ts";
import * as pycompat from "../../hooks/lib/hookkit/pycompat.ts";
import * as repo from "../../hooks/lib/hookkit/repo.ts";
import { readTsv } from "../../hooks/lib/hookkit/overlay.ts";
import * as transcript from "../../hooks/lib/hookkit/transcript.ts";
import { KEEL_HOME, Sandbox, withEnv } from "./helpers.ts";

const FIRST_LINE = /^\[[A-Za-z0-9-]+\] (ship-gate|git-guard|report-gate|model-assign|env-preflight): \S/;
const BULLET = /^- \[[A-Za-z0-9-]+\] \S/;
const EMIT = join(import.meta.dirname, "protocol-emit.ts");

function directoryServicesOnlyAccount(): string | null {
  if (process.platform !== "darwin") return null;
  const listed = spawnSync("dscl", [".", "-list", "/Users"], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  const passwdNames = new Set(readFileSync("/etc/passwd", "utf8").split("\n").map((line) => line.split(":")[0]));
  return listed.stdout.split("\n").find((name) => name !== "" && !name.startsWith("_") && !passwdNames.has(name)) ?? null;
}

function captured(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  return undefined;
}

function emit(name: string, ...args: unknown[]) {
  const result = spawnSync(process.execPath, [EMIT, name, JSON.stringify(args)], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("python string behaviors", () => {
  it("splitlines_breaksOnEveryUnicodeLineBreak_andDropsTheTrailingEmptyElement", () => {
    assert.deepEqual(pycompat.splitlines("a\r\nb\rc\x0bd\x0ce\x1cf\x85g\u2028h\u2029i\n"), ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert.deepEqual(pycompat.splitlines("\n"), [""]);
    assert.deepEqual(pycompat.splitlines(""), []);
    assert.deepEqual(pycompat.splitlines("a\n\n"), ["a", ""]);
  });

  it("universalNewlineLines_splitsOnCarriageReturnAndLineFeed_notOnOtherUnicodeBreaks", () => {
    const sandbox = new Sandbox();
    try {
      const path = sandbox.write(join(sandbox.root, "lines.txt"), "a\r\nb\rc\nd\x0be\u2028f\n");

      assert.deepEqual(pycompat.universalNewlineLines(path), ["a", "b", "c", "d\x0be\u2028f"]);
    } finally {
      sandbox.close();
    }
  });

  it("strip_removesPythonWhitespace_notTheByteOrderMark", () => {
    assert.equal(pycompat.strip("\x1cx\x85"), "x");
    assert.equal(pycompat.strip("\ufeffx"), "\ufeffx");
  });

  it("isDigits_acceptsSuperscriptsAndDecimalDigits_butNotLettersOrEmpty", () => {
    assert.deepEqual(["²", "5", "٣", "x", ""].map(pycompat.isDigits), [true, true, true, false, false]);
  });

  it("truncate_countsCodePoints_andANegativeCountDropsFromTheEnd", () => {
    assert.equal(pycompat.truncate("😀😀😀", 2), "😀😀");
    assert.equal(pycompat.truncate("abcdef", -2), "abcd");
    assert.equal(pycompat.truncate("ab", 5), "ab");
  });

  it("pythonStr_spellsPythonValues", () => {
    assert.deepEqual([null, true, false, "s", 7, ["a", 1], { k: "v" }].map(pycompat.pythonStr), ["None", "True", "False", "s", "7", "['a', 1]", "{'k': 'v'}"]);
  });

  it("pythonStr_spellsNonFiniteNumbersLikePythonFloat", () => {
    assert.deepEqual([NaN, Infinity, -Infinity, [NaN], { a: Infinity }].map(pycompat.pythonStr), ["nan", "inf", "-inf", "[nan]", "{'a': inf}"]);
  });
});

describe("python path behaviors", () => {
  it("normalizePath_dropsTrailingSlash_keepsTwoLeadingSlashes", () => {
    const cases: Array<[string, string]> = [["/a/", "/a"], ["//x", "//x"], ["///x", "/x"], ["a/../..", ".."], ["", "."], ["/..", "/"], ["a//b/./c/", "a/b/c"], ["//", "//"]];
    for (const [path, expected] of cases) assert.equal(pycompat.normalizePath(path), expected, path);
  });

  it("joinPath_restartsAtAnAbsolutePart", () => {
    assert.equal(pycompat.joinPath("a", "/b"), "/b");
    assert.equal(pycompat.joinPath("a/", "b"), "a/b");
    assert.equal(pycompat.joinPath("", "b"), "b");
    assert.equal(pycompat.joinPath("a", ""), "a/");
  });

  it("basename_isEmpty_forATrailingSlash", () => {
    assert.deepEqual(["git/", "/usr/bin/git", "git"].map(pycompat.basename), ["", "git", "git"]);
  });

  it("expandVars_replacesOnlyDefinedAsciiNames", () => {
    withEnv({ KEEL_T: "v" }, () => {
      assert.equal(pycompat.expandVars("$KEEL_T/${KEEL_T}/$NOPE_X/é$KEEL_T"), "v/v/$NOPE_X/év");
    });
  });

  it("expandVars_keepsTheRestOfTheWord_afterAnUnclosedBrace", () => {
    withEnv({ KEEL_T: "v" }, () => {
      assert.equal(pycompat.expandVars("${x$KEEL_T/a"), "${x$KEEL_T/a");
      assert.equal(pycompat.expandVars("$KEEL_T/${x"), "v/${x");
      assert.equal(pycompat.expandVars("${KEEL_Tx"), "${KEEL_Tx");
      assert.equal(pycompat.expandVars("${KEEL_T"), "${KEEL_T");
    });
  });

  it("expandUser_readsHomeAtCallTime_andLooksUpNamedAccounts", () => {
    withEnv({ HOME: "/home/u/" }, () => {
      assert.equal(pycompat.expandUser("~/x"), "/home/u/x");
      assert.equal(pycompat.expandUser("~"), "/home/u");
    });
    assert.equal(pycompat.expandUser("~nosuchuserzz/x"), "~nosuchuserzz/x");
  });

  it("expandUser_resolvesAnAccountOnlyDirectoryServicesKnows_likePythonGetpwnam", (context) => {
    const name = directoryServicesOnlyAccount();
    if (name === null) return context.skip("no account outside /etc/passwd on this machine");

    const home = spawnSync("dscl", [".", "-read", `/Users/${name}`, "NFSHomeDirectory"], { encoding: "utf8" });

    assert.equal(home.status, 0, home.stderr);
    const directory = /^NFSHomeDirectory: (\S+)$/m.exec(home.stdout)?.[1];
    assert.ok(directory, home.stdout);
    assert.equal(pycompat.expandUser(`~${name}/x`), `${directory.replace(/\/+$/, "")}/x`);
  });

  it("expandUser_spawnsTheDirectoryLookupOnce_perName", (context) => {
    if (process.platform !== "darwin") return context.skip("directory services lookup is macOS only");
    const sandbox = new Sandbox();
    try {
      const counter = join(sandbox.root, "dscl-calls");
      const dscl = sandbox.write(join(sandbox.root, "stubs", "dscl"),
        `#!/bin/bash\necho call >> '${counter}'\n[ "$4" = /Users/keelstubuser ] || exit 56\necho '<key>dsAttrTypeStandard:NFSHomeDirectory</key><array><string>/stub/h&amp;me/</string><string>/other</string></array>'\n`);
      chmodSync(dscl, 0o755);
      writeFileSync(counter, "");

      withEnv({ PATH: join(sandbox.root, "stubs") + delimiter + (process.env["PATH"] ?? "") }, () => {
        assert.equal(pycompat.expandUser("~keelstubuser/a"), "/stub/h&me/a");
        assert.equal(pycompat.expandUser("~keelstubuser/b"), "/stub/h&me/b");
        assert.equal(pycompat.expandUser("~keelmissinguser/a"), "~keelmissinguser/a");
        assert.equal(pycompat.expandUser("~keelmissinguser/b"), "~keelmissinguser/b");
      });

      assert.equal(readFileSync(counter, "utf8"), "call\ncall\n");
    } finally {
      sandbox.close();
    }
  });
});

describe("isSystemError", () => {
  it("isSystemError_isTrueForFilesystemFailures_only", () => {
    assert.equal(pycompat.isSystemError(captured(() => readFileSync("/nonexistent/keel"))), true);
    assert.equal(pycompat.isSystemError(captured(() => readFileSync("/"))), true);
    assert.equal(pycompat.isSystemError(captured(() => readFileSync("a\0b"))), false);
    assert.equal(pycompat.isSystemError(new SyntaxError("bad")), false);
    assert.equal(pycompat.isSystemError("ENOENT"), false);
  });
});

describe("python glob", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
    for (const file of ["cfg/top.conf", "cfg/.dot.conf", "cfg/sub/deep.conf", "cfg/sub/sub2/deeper.conf", "cfg/dirx.conf/inner"]) {
      sandbox.write(join(sandbox.root, file), "x\n");
    }
  });
  afterEach(() => sandbox.close());

  function matches(pattern: string): string[] {
    return pycompat.sortedByCodePoint(pycompat.glob(join(sandbox.root, pattern)).map((path) => path.slice(sandbox.root.length + 1)));
  }

  it("glob_readsDoubleStarAsStar_withoutRecursion", () => {
    assert.deepEqual(matches("cfg/**/*.conf"), ["cfg/sub/deep.conf"]);
    assert.deepEqual(matches("cfg/**"), ["cfg/dirx.conf", "cfg/sub", "cfg/top.conf"]);
    assert.deepEqual(matches("cfg/s*/**/*.conf"), ["cfg/sub/sub2/deeper.conf"]);
  });

  it("glob_treatsBracesAsLiteralText", () => {
    assert.deepEqual(matches("cfg/{top,sub/deep}.conf"), []);
  });

  it("glob_hidesDotfiles_unlessTheSegmentStartsWithADot", () => {
    assert.deepEqual(matches("cfg/*.conf"), ["cfg/dirx.conf", "cfg/top.conf"]);
    assert.deepEqual(matches("cfg/.*.conf"), ["cfg/.dot.conf"]);
    assert.deepEqual(matches("cfg/[.]dot.conf"), []);
    assert.deepEqual(matches("cfg/.dot.conf"), ["cfg/.dot.conf"]);
  });

  it("glob_matchesQuestionMarkAndCharacterClasses", () => {
    assert.deepEqual(matches("cfg/to?.conf"), ["cfg/top.conf"]);
    assert.deepEqual(matches("cfg/[a-t]op.conf"), ["cfg/top.conf"]);
    assert.deepEqual(matches("cfg/[!t]*.conf"), ["cfg/dirx.conf"]);
    assert.deepEqual(matches("cfg/[z-a]op.conf"), []);
    assert.deepEqual(matches("cfg/[!]op.conf"), []);
  });

  it("glob_keepsATrailingSlash_forDirectoriesOnly", () => {
    assert.deepEqual(matches("cfg/*/"), ["cfg/dirx.conf/", "cfg/sub/"]);
    assert.deepEqual(matches("cfg/*/*"), ["cfg/dirx.conf/inner", "cfg/sub/deep.conf", "cfg/sub/sub2"]);
  });

  it("glob_returnsAPlainPath_onlyWhenItExists", () => {
    assert.deepEqual(matches("cfg/top.conf"), ["cfg/top.conf"]);
    assert.deepEqual(matches("cfg/missing.conf"), []);
    assert.deepEqual(matches("cfg//*.conf"), ["cfg/dirx.conf", "cfg/top.conf"]);
  });
});

describe("pythonJsonDumps", () => {
  it("matches json.dumps(ensure_ascii=False) for non-ASCII text, control characters and nesting", () => {
    const fixture = {
      ts: "2026-10-22T01:02:03Z", detail: "héllo 日本語 \"q\" \\ \n tab\t ctl\u0001 😀", n: 3, ok: true, none: null,
      nested: { list: [1, "é", { k: [] }, {}], empty: {} }, arr: [],
    };
    const expected = '{"ts": "2026-10-22T01:02:03Z", "detail": "héllo 日本語 \\"q\\" \\\\ \\n tab\\t ctl\\u0001 😀", "n": 3, "ok": true, ' +
      '"none": null, "nested": {"list": [1, "é", {"k": []}, {}], "empty": {}}, "arr": []}';
    assert.equal(pycompat.pythonJsonDumps(fixture), expected);
  });
});

describe("pythonJsonDumps semantic limits", () => {
  it("pythonJsonDumps_reordersIntegerLikeKeys_andPrintsWholeFloatsAsIntegers", () => {
    const parsed: unknown = JSON.parse('{"command":"ls","2":"x","timeout":1.0}');

    assert.equal(pycompat.pythonJsonDumps(parsed), '{"2": "x", "command": "ls", "timeout": 1}');
  });
});

describe("protocol output", () => {
  it("warn_printsOneJsonLine_andPasses", () => {
    const result = emit("warn", "Stop", "[K1] h: 日本語");
    assert.deepEqual(result, { code: 0, stdout: '{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "[K1] h: 日本語"}}\n', stderr: "" });
  });

  it("blockStop_printsTheBlockDecision", () => {
    assert.deepEqual(emit("blockStop", "x\ny"), { code: 0, stdout: '{"decision": "block", "reason": "x\\ny"}\n', stderr: "" });
  });

  it("rewriteInput_printsTheUpdatedInputWithTheNote", () => {
    const expected = '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": "echo é"}}, ' +
      '"systemMessage": "note ✓", "suppressOutput": true}\n';
    assert.deepEqual(emit("rewriteInput", { command: "echo é" }, "note ✓"), { code: 0, stdout: expected, stderr: "" });
  });

  it("deny_writesTheMessageToStderr_andExitsTwo", () => {
    assert.deepEqual(emit("deny", "[K1] h: no"), { code: 2, stdout: "", stderr: "[K1] h: no\n" });
  });
});

describe("protocol payload", () => {
  it("parsePayload_returnsAnObject_andRejectsOtherJson", () => {
    assert.deepEqual(parsePayload('{"tool_name": "Bash"}'), { tool_name: "Bash" });
    assert.throws(() => parsePayload("[1]"), /not a JSON object/);
    assert.throws(() => parsePayload('{"a": '), JsonSyntaxError);
  });

  it("toolName_isLowerCased_andEmptyWhenAbsentOrFalsy", () => {
    assert.deepEqual([{ tool_name: "Bash" }, {}, { tool_name: 0 }, { tool_name: null }].map(protocol.toolName), ["bash", "", "", ""]);
  });

  it("toolInput_isAnObject_whateverThePayloadHolds", () => {
    assert.deepEqual(protocol.toolInput({ tool_input: { command: "ls" } }), { command: "ls" });
    assert.deepEqual([{ tool_input: [1] }, { tool_input: "s" }, {}].map(protocol.toolInput), [{}, {}, {}]);
  });

  it("isSubagent_followsPythonTruthiness", () => {
    assert.deepEqual([{ agent_id: "a1" }, { agent_id: "" }, { agent_id: [] }, {}].map(protocol.isSubagent), [true, false, false, false]);
  });

  it("formatMessage_countsTheCapInCodePoints_andKeepsTheLastLine", () => {
    const message = protocol.formatMessage("h", "s", [["K1", "😀".repeat(3000)]], protocol.runYourself("git push"));
    assert.equal(Array.from(message).length, protocol.MESSAGE_LIMIT);
    assert.ok(message.endsWith("…\nRun it yourself in your terminal: git push"));
  });

  it("formatWarning_capsAtTheLimitWithAnEllipsis", () => {
    const message = protocol.formatWarning("h", "s", [["K1", "x".repeat(5000)]]);
    assert.equal(Array.from(message).length, protocol.MESSAGE_LIMIT);
    assert.ok(message.endsWith("…"));
  });

  it("formatMessage_followsTheMessageContractShape", () => {
    const message = protocol.formatMessage("git-guard", "blocked", [["F-secrets", "a"], ["K1", "b"]], protocol.runYourself("cd /x && git push"));
    const lines = message.split("\n");
    assert.match(lines[0] ?? "", FIRST_LINE);
    assert.ok(lines.length >= 3);
    for (const line of lines.slice(1, -1)) assert.match(line, BULLET);
    assert.ok((lines.at(-1) ?? "").startsWith(protocol.RUN_YOURSELF));
  });

  it("formatWarning_followsTheMessageContractShape", () => {
    const lines = protocol.formatWarning("ship-gate", "stale", [["K1", "x"]]).split("\n");
    assert.match(lines[0] ?? "", FIRST_LINE);
    for (const line of lines.slice(1)) assert.match(line, BULLET);
  });
});

describe("contract and env", () => {
  it("missingFields_treatsAnEmptyMapAZeroAndAnEmptyListAsPresent", () => {
    assert.deepEqual(missingFields({ a: {}, b: 0, c: [], d: false }, "a", "b", "c", "d", "e"), ["e"]);
  });

  it("env_resolvesDirectoriesFromTheVariablesThenTheDefaults", () => {
    withEnv({ HOME: "/home/u", KEEL_DATA_DIR: "~/data", KEEL_OVERLAY_DIR: null, KEEL_CLI: null, KEEL_BOUNDARY: null, KEEL_HOME: "~/k" }, () => {
      assert.equal(env.dataDir(), "/home/u/data");
      assert.equal(env.overlayDir(), "/home/u/git/keel-overlay");
      assert.equal(env.overlayPath("git-guard", "x.tsv"), "/home/u/git/keel-overlay/git-guard/x.tsv");
      assert.equal(env.keelHome(), "/home/u/k");
      assert.equal(env.keelCli(), "/home/u/k/bin/keel");
      assert.equal(env.boundaryScanner(), "/home/u/k/measure/boundary");
    });
  });

  it("keelHome_isTheCheckoutHoldingHooksLib_whenNoVariableIsSet", () => {
    withEnv({ KEEL_HOME: null }, () => assert.equal(env.keelHome(), KEEL_HOME));
  });
});

describe("FireLog", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
  });
  afterEach(() => sandbox.close());

  function logged(): Array<Record<string, unknown>> {
    const text = readFileSync(join(sandbox.data, "logs", "keel-fires.jsonl"), "utf8");
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("append_writesOnePythonStyleJsonLine_withTheDetailCappedInCodePoints", () => {
    withEnv({ KEEL_DATA_DIR: sandbox.data }, () => {
      new FireLog("git-guard", "s1").append("F-secrets", "deny", { detail: "😀".repeat(300), count: 3, skipped: null });
    });
    const text = readFileSync(join(sandbox.data, "logs", "keel-fires.jsonl"), "utf8");
    assert.match(text, /^\{"ts": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", "rule_id": "F-secrets", "hook": "git-guard", "outcome": "deny", "session": "s1", "detail": "(😀){200}", "count": 3\}\n$/u);
  });

  it("append_namesTheSessionAsDash_whenThePayloadHasNone", () => {
    withEnv({ KEEL_DATA_DIR: sandbox.data }, () => new FireLog("h", null).append("K1", "pass"));
    assert.equal(logged()[0]?.["session"], "-");
  });

  it("append_doesNotThrow_whenTheLogCannotBeWritten", () => {
    mkdirSync(join(sandbox.data, "logs", "keel-fires.jsonl"), { recursive: true });
    withEnv({ KEEL_DATA_DIR: sandbox.data }, () => new FireLog("h", "s").append("K1", "pass"));
  });

  it("append_throws_whenTheRecordCannotBeSerialized", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    withEnv({ KEEL_DATA_DIR: sandbox.data }, () => {
      assert.throws(() => new FireLog("h", "s").append("K1", "pass", { context: loop }));
    });
  });
});

describe("overlay and transcript files", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
  });
  afterEach(() => sandbox.close());

  it("readTsv_readsCarriageReturnLineEndings_andReportsTheLineNumber", () => {
    const path = sandbox.write(join(sandbox.overlay, "x.tsv"), "a\tb\r1\t2\r3\r");
    assert.throws(() => readTsv(path, ["a", "b"]), new RegExp(`${path}:3: expected 2 columns`));
  });

  it("readTsv_doesNotSplitOnOtherUnicodeLineBreaks", () => {
    const path = sandbox.write(join(sandbox.overlay, "x.tsv"), "a\tb\n1\u2028x\t2\n");
    assert.deepEqual(readTsv(path, ["a", "b"]), [{ a: "1\u2028x", b: "2" }]);
  });

  it("iterEntries_skipsBlankMalformedAndNonObjectLines", () => {
    const path = sandbox.write(join(sandbox.root, "t.jsonl"), '{"a": 1}\n\nnot json\n[1]\n  {"b": 2}  \n');
    assert.deepEqual(Array.from(transcript.iterEntries(path)), [{ a: 1 }, { b: 2 }]);
  });

  it("iterEntries_readsADeeplyNestedLine_likePython", () => {
    const deep = "[".repeat(9999) + "]".repeat(9999);
    const path = sandbox.write(join(sandbox.root, "deep.jsonl"), `{"a": 1}\n{"deep": ${deep}}\n{"b": 2}\n`);
    assert.deepEqual(Array.from(transcript.iterEntries(path)).map((entry) => Object.keys(entry)), [["a"], ["deep"], ["b"]]);
  });

  it("iterEntries_raisesRecursionError_whenALineNestsPastTheDepthBound", () => {
    const deep = "[".repeat(140000) + "]".repeat(140000);
    const path = sandbox.write(join(sandbox.root, "past-bound.jsonl"), `{"a": 1}\n{"deep": ${deep}}\n`);
    assert.throws(() => Array.from(transcript.iterEntries(path)), RecursionError);
  });

  it("iterEntries_readsALineHoldingAnIntegerPastPythonsDigitLimit", () => {
    const path = sandbox.write(join(sandbox.root, "big.jsonl"), `{"a": 1}\n{"n": ${"1".repeat(4301)}}\n{"b": 2}\n`);
    assert.deepEqual(Array.from(transcript.iterEntries(path)).map((entry) => Object.keys(entry)), [["a"], ["n"], ["b"]]);
  });

  it("textOf_readsStringsBlocksAndMessageWrappers", () => {
    assert.equal(transcript.textOf("s"), "s");
    assert.equal(transcript.textOf({ text: "t" }), "t");
    assert.equal(transcript.textOf({ message: { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] } }), "a\nb");
    assert.equal(transcript.textOf([]), "");
    assert.equal(transcript.textOf({ other: 1 }), null);
    assert.equal(transcript.textOf(3), null);
  });

  it("roleOf_fallsBackToTheEntryType_andToolUsesListsToolUseBlocks", () => {
    assert.equal(transcript.roleOf({ message: { role: "assistant" }, type: "x" }), "assistant");
    assert.equal(transcript.roleOf({ type: "user" }), "user");
    const entry = { message: { content: [{ type: "tool_use", name: "Edit" }, { type: "text", text: "x" }] } };
    assert.deepEqual(transcript.toolUses(entry), [{ type: "tool_use", name: "Edit" }]);
    assert.deepEqual(transcript.toolUses({ message: { content: "s" } }), []);
  });
});

describe("repo", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
  });
  afterEach(() => sandbox.close());

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }

  it("gitFacts_readToplevelRepoKeyAndBranch_fromARealCheckout", () => {
    const work = join(sandbox.root, "work");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    git(work, "remote", "add", "origin", "git@example.com:Acme/App.git");
    git(work, "commit", "-q", "--allow-empty", "-m", "start");
    assert.equal(repo.findToplevel(work), work);
    assert.equal(repo.findRepoKey(work), "acme/app");
    assert.equal(repo.currentBranch(work), "main");
    assert.equal(repo.isCommit(work, "HEAD"), true);
    assert.equal(repo.findUpstream(work, "main"), null);
    assert.equal(repo.findSuperproject(work), null);
  });

  it("gitOutput_isNone_whenTheDirectoryIsMissingOrNotARepository", () => {
    assert.equal(repo.gitOutput(["status"], join(sandbox.root, "absent")), null);
    assert.equal(repo.gitOutput(["rev-parse", "--show-toplevel"], sandbox.home), null);
  });
});
