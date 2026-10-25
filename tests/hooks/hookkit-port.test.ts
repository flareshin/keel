import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { missingFields } from "../../hooks/lib/hookkit/contract.ts";
import * as env from "../../hooks/lib/hookkit/env.ts";
import { FireLog } from "../../hooks/lib/hookkit/fires.ts";
import * as protocol from "../../hooks/lib/hookkit/protocol.ts";
import { JsonSyntaxError, parsePayload } from "../../hooks/lib/hookkit/json.ts";
import { RecursionError, ValueError } from "../../hooks/lib/hookkit/errors.ts";
import { isSystemError } from "../../hooks/lib/hookkit/files.ts";
import { pythonJsonDumps } from "../../hooks/lib/hookkit/jsonout.ts";
import { basename, expandUser, expandVars, glob, joinPath, normalizePath } from "../../hooks/lib/hookkit/paths.ts";
import { isDigits, splitlines, trimSpace, truncate } from "../../hooks/lib/hookkit/text.ts";
import * as repo from "../../hooks/lib/hookkit/repo.ts";
import { readTsv } from "../../hooks/lib/hookkit/overlay.ts";
import * as transcript from "../../hooks/lib/hookkit/transcript.ts";
import { compareCodePoints } from "../../measure/lib/measurekit/json.ts";
import { KEEL_HOME, Sandbox, withEnv } from "./helpers.ts";

const FIRST_LINE = /^\[[A-Za-z0-9-]+\] (ship-gate|git-guard|report-gate|model-assign|env-preflight): \S/;
const BULLET = /^- \[[A-Za-z0-9-]+\] \S/;
const EMIT = join(import.meta.dirname, "protocol-emit.ts");

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

describe("text helpers", () => {
  it("splitlines_breaksOnEveryUnicodeLineBreak_andDropsTheTrailingEmptyElement", () => {
    assert.deepEqual(splitlines("a\r\nb\rc\x0bd\x0ce\x1cf\x85g\u2028h\u2029i\n"), ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert.deepEqual(splitlines("\n"), [""]);
    assert.deepEqual(splitlines(""), []);
    assert.deepEqual(splitlines("a\n\n"), ["a", ""]);
  });

  it("trimSpace_removesTheHookkitSpaceCharacters_notTheByteOrderMark", () => {
    assert.equal(trimSpace("\x1cx\x85"), "x");
    assert.equal(trimSpace("\ufeffx"), "\ufeffx");
  });

  it("isDigits_acceptsSuperscriptsAndDecimalDigits_butNotLettersOrEmpty", () => {
    assert.deepEqual(["²", "5", "٣", "x", ""].map(isDigits), [true, true, true, false, false]);
  });

  it("truncate_countsCodePoints_andANegativeCountDropsFromTheEnd", () => {
    assert.equal(truncate("😀😀😀", 2), "😀😀");
    assert.equal(truncate("abcdef", -2), "abcd");
    assert.equal(truncate("ab", 5), "ab");
  });
});

describe("path helpers", () => {
  it("normalizePath_dropsTrailingSlash_keepsTwoLeadingSlashes", () => {
    const cases: Array<[string, string]> = [["/a/", "/a"], ["//x", "//x"], ["///x", "/x"], ["a/../..", ".."], ["", "."], ["/..", "/"], ["a//b/./c/", "a/b/c"], ["//", "//"]];
    for (const [path, expected] of cases) assert.equal(normalizePath(path), expected, path);
  });

  it("joinPath_restartsAtAnAbsolutePart", () => {
    assert.equal(joinPath("a", "/b"), "/b");
    assert.equal(joinPath("a/", "b"), "a/b");
    assert.equal(joinPath("", "b"), "b");
    assert.equal(joinPath("a", ""), "a/");
  });

  it("basename_isEmpty_forATrailingSlash", () => {
    assert.deepEqual(["git/", "/usr/bin/git", "git"].map(basename), ["", "git", "git"]);
  });

  it("expandVars_replacesOnlyDefinedAsciiNames", () => {
    withEnv({ KEEL_T: "v" }, () => {
      assert.equal(expandVars("$KEEL_T/${KEEL_T}/$NOPE_X/é$KEEL_T"), "v/v/$NOPE_X/év");
    });
  });

  it("expandVars_keepsTheRestOfTheWord_afterAnUnclosedBrace", () => {
    withEnv({ KEEL_T: "v" }, () => {
      assert.equal(expandVars("${x$KEEL_T/a"), "${x$KEEL_T/a");
      assert.equal(expandVars("$KEEL_T/${x"), "v/${x");
      assert.equal(expandVars("${KEEL_Tx"), "${KEEL_Tx");
      assert.equal(expandVars("${KEEL_T"), "${KEEL_T");
    });
  });

  it("expandUser_readsHomeAtCallTime_andExpandsTheCurrentUserByName", () => {
    withEnv({ HOME: "/home/u/" }, () => {
      assert.equal(expandUser("~/x"), "/home/u/x");
      assert.equal(expandUser("~"), "/home/u");
    });
    const { username, homedir } = userInfo();
    assert.equal(expandUser(`~${username}/x`), `${homedir.replace(/\/+$/, "")}/x`);
    assert.equal(expandUser(`~${username}`), homedir.replace(/\/+$/, "") || "/");
  });

  it("expandUser_keepsATildeNameThatIsNotTheCurrentUser", () => {
    const { username } = userInfo();
    assert.equal(expandUser("~nosuchuserzz/x"), "~nosuchuserzz/x");
    assert.equal(expandUser(`~${username}x/a`), `~${username}x/a`);
    assert.equal(expandUser(`x~${username}/a`), `x~${username}/a`);
  });
});

describe("isSystemError", () => {
  it("isSystemError_isTrueForFilesystemFailures_only", () => {
    assert.equal(isSystemError(captured(() => readFileSync("/nonexistent/keel"))), true);
    assert.equal(isSystemError(captured(() => readFileSync("/"))), true);
    assert.equal(isSystemError(captured(() => readFileSync("a\0b"))), false);
    assert.equal(isSystemError(new SyntaxError("bad")), false);
    assert.equal(isSystemError("ENOENT"), false);
  });
});

describe("glob", () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = new Sandbox();
    for (const file of ["cfg/top.conf", "cfg/.dot.conf", "cfg/sub/deep.conf", "cfg/sub/sub2/deeper.conf", "cfg/dirx.conf/inner"]) {
      sandbox.write(join(sandbox.root, file), "x\n");
    }
  });
  afterEach(() => sandbox.close());

  function matches(pattern: string): string[] {
    return glob(join(sandbox.root, pattern)).map((path) => path.slice(sandbox.root.length + 1)).sort(compareCodePoints);
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
    assert.equal(pythonJsonDumps(fixture), expected);
  });
});

describe("pythonJsonDumps semantic limits", () => {
  it("pythonJsonDumps_reordersIntegerLikeKeys_andPrintsWholeFloatsAsIntegers", () => {
    const parsed: unknown = JSON.parse('{"command":"ls","2":"x","timeout":1.0}');

    assert.equal(pythonJsonDumps(parsed), '{"2": "x", "command": "ls", "timeout": 1}');
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

  it("iterEntries_splitsOnCarriageReturnAndLineFeed_notOnOtherUnicodeBreaks", () => {
    const path = sandbox.write(join(sandbox.root, "breaks.jsonl"), '{"a": 1}\r{"b": 2}\r\n{"t": "x\u2028y\x85z"}\n');
    assert.deepEqual(Array.from(transcript.iterEntries(path)), [{ a: 1 }, { b: 2 }, { t: "x\u2028y\x85z" }]);
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
