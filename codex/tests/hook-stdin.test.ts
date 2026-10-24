import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { withEnv } from "../../tests/hooks/helpers.ts";
import type { CompletedProcess } from "../../hooks/lib/hookkit/subprocess.ts";
import { main as runHook } from "../hooks/pre-tool-use.ts";
import type { GuardRunner } from "../hooks/pre-tool-use.ts";

const HOOK = join(import.meta.dirname, "..", "hooks", "pre-tool-use.ts");
const NOT_UTF8_REASON = "keel Codex guard: stdin is not valid UTF-8";
const PYTHON_TEXT_SETTINGS: Array<Record<string, string>> = [
  {}, { PYTHONUTF8: "0" }, { PYTHONUTF8: "1" }, { PYTHONUTF8: "2" }, { PYTHONUTF8: "bogus", PYTHONIOENCODING: "utf-8" },
  { PYTHONIOENCODING: "utf-16" }, { PYTHONIOENCODING: "bogus" }, { PYTHONIOENCODING: "ascii:strict" }, { PYTHONIOENCODING: "utf-8-sig" },
  { PYTHONIOENCODING: "latin-1:replace" }, { PYTHONIOENCODING: "hex" }, { PYTHONUTF8: "0", LC_ALL: "C" }, { PYTHONUTF8: "0", LANG: "ko_KR.eucKR" },
];
const INVALID_SEQUENCES: Record<string, number[]> = {
  "start byte": [0xff], "truncated sequence": [0xe2, 0x82], "overlong slash": [0xc0, 0xaf], "encoded surrogate": [0xed, 0xa0, 0x80],
  "bad continuation": [0xc3, 0x28], "past U+10FFFF": [0xf4, 0x90, 0x80, 0x80], "lone continuation": [0x80], "latin-1 e acute": [0xe9],
};

describe("hook stdin", () => {
  let temp: string;
  let environment: Record<string, string>;

  before(() => {
    temp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-hook-stdin-")));
    spawnSync("git", ["init", "-q", temp], { stdio: "ignore" });
    environment = { HOME: temp, KEEL_CODEX_HOME: join(temp, "profile"), KEEL_AGENTS_HOME: join(temp, "agents"), KEEL_DATA_DIR: join(temp, "data"), KEEL_OVERLAY_DIR: join(temp, "overlay") };
  });

  after(() => rmSync(temp, { recursive: true, force: true }));

  const payload = (command: string): Buffer => Buffer.from(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: temp }), "utf8");

  function guardsSeen(stdin: Buffer, extra: Record<string, string> = {}): { code: number; stdout: string; guards: number } {
    let guards = 0;
    const runner: GuardRunner = (): CompletedProcess => {
      guards += 1;
      return { returncode: 0, stdout: "", stderr: "" };
    };
    const result = withEnv({ ...environment, ...extra }, () => runHook(() => stdin, runner));
    return { code: result.code, stdout: result.stdout, guards };
  }

  for (const [name, bytes] of Object.entries(INVALID_SEQUENCES)) {
    it(`main_deniesWithoutCallingAGuard_whenStdinHolds (${name})`, () => {
      const stdin = Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo '), Buffer.from(bytes), Buffer.from('"}}')]);
      const seen = guardsSeen(stdin);
      assert.equal(seen.code, 0);
      assert.equal(seen.guards, 0);
      assert.equal(JSON.parse(seen.stdout).hookSpecificOutput.permissionDecisionReason, NOT_UTF8_REASON);
      assert.equal(JSON.parse(seen.stdout).hookSpecificOutput.permissionDecision, "deny");
    });
  }

  it("main_decodesTheSameWayUnderEveryPythonTextSetting", () => {
    const valid = payload("echo héllo \u{1f600}");
    const invalid = Buffer.concat([valid.subarray(0, 40), Buffer.from([0xff]), valid.subarray(40)]);
    for (const settings of PYTHON_TEXT_SETTINGS) {
      assert.deepEqual(guardsSeen(valid, settings), { code: 0, stdout: "", guards: 2 }, JSON.stringify(settings));
      const denied = guardsSeen(invalid, settings);
      assert.equal(denied.guards, 0, JSON.stringify(settings));
      assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, NOT_UTF8_REASON, JSON.stringify(settings));
    }
  });

  it("main_deniesInputThatBeginsWithAByteOrderMark_andOneThatEndsInside", () => {
    const withByteOrderMark = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload("echo hi")]);
    for (const stdin of [withByteOrderMark, withByteOrderMark.subarray(0, 2), Buffer.from([0xef])]) assert.equal(JSON.parse(guardsSeen(stdin).stdout).hookSpecificOutput.permissionDecision, "deny");
  });

  it("hookProcess_exitsZeroWithAJsonDenial_andNothingOnStderr_forInvalidUtf8UnderAnyPythonSetting", () => {
    const stdin = Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo '), Buffer.from([0xff]), Buffer.from('"}}')]);
    for (const settings of PYTHON_TEXT_SETTINGS) {
      const run = spawnSync(process.execPath, [HOOK], { input: stdin, env: { ...process.env, ...environment, ...settings }, encoding: "utf8" });
      assert.equal(run.status, 0, JSON.stringify(settings));
      assert.equal(run.stderr, "", JSON.stringify(settings));
      assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason, NOT_UTF8_REASON, JSON.stringify(settings));
    }
  });

  it("hookProcess_passesAValidPayloadSilently_andWritesNoByteOrderMark_underUtf8Sig", () => {
    const run = spawnSync(process.execPath, [HOOK], { input: payload("git status"), env: { ...process.env, ...environment, PYTHONIOENCODING: "utf-8-sig" }, encoding: "buffer" });
    assert.equal(run.status, 0);
    assert.equal(run.stdout.length, 0);
    const denied = spawnSync(process.execPath, [HOOK], { input: payload("git push --force origin main"), env: { ...process.env, ...environment, PYTHONIOENCODING: "utf-8-sig" }, encoding: "buffer" });
    assert.notDeepEqual([...denied.stdout.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(JSON.parse(denied.stdout.toString("utf8")).hookSpecificOutput.permissionDecision, "deny");
  });
});
