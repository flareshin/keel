import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { run } from "../../hooks/lib/hookkit/subprocess.ts";
import type { CompletedProcess } from "../../hooks/lib/hookkit/subprocess.ts";
import { withEnv } from "../../tests/hooks/helpers.ts";
import { recordedAnswers } from "../../tests/recorded.ts";
import { main as runHook } from "../hooks/pre-tool-use.ts";
import type { GuardRunner } from "../hooks/pre-tool-use.ts";
import { EXPECTED_DEPTH_DENY_REASON, JSON_DEPTH_BOUND } from "./json-depth-policy.ts";

const GUARD_TIMEOUT_SECONDS = 35;
const PAST_THE_BOUND = 2 * JSON_DEPTH_BOUND;
const FORCE_PUSH_REASON = "F-force-push";
const REFUSED_BEFORE_ANY_GUARD: Record<string, string> = { "deep array as cwd": "keel Codex guard: cwd must be a string" };

function deepArray(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

describe("git-guard JSON depth bound", () => {
  let temp: string;

  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-guard-depth-")));
    spawnSync("git", ["init", "-q", temp], { stdio: "ignore" });
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  const sandboxEnv = (): Record<string, string> => ({
    HOME: temp, KEEL_CODEX_HOME: join(temp, "profile"), KEEL_AGENTS_HOME: join(temp, "agents"), KEEL_DATA_DIR: join(temp, "data"), KEEL_OVERLAY_DIR: join(temp, "overlay"),
  });

  const typescriptGuard: GuardRunner = (command, input): CompletedProcess => run(command, GUARD_TIMEOUT_SECONDS, { input });

  function payloads(): Array<[name: string, text: string, deniedForcePush: boolean]> {
    const deep = deepArray(PAST_THE_BOUND);
    const write = (content: string, extra: string): string =>
      `{"tool_name": "Write", "tool_input": {"file_path": ${JSON.stringify(join(temp, "profile", "notes.txt"))}, "content": ${content}}, "cwd": ${JSON.stringify(temp)}${extra}}`;
    const bash = (command: string, extra: string): string =>
      `{"tool_name": "Bash", "tool_input": {"command": ${JSON.stringify(command)}}, "cwd": ${JSON.stringify(temp)}${extra}}`;
    return [
      ["deep array beside allowed write", write('"x"', `, "deep": ${deep}`), false],
      ["deep object beside allowed write", write('"x"', `, "deep": ${'{"a": '.repeat(PAST_THE_BOUND)}1${"}".repeat(PAST_THE_BOUND)}`), false],
      ["deep array inside tool_input", write(deep, ""), false],
      ["deep array beside force push", bash("git push --force origin main", `, "deep": ${deep}`), true],
      ["deep array as cwd", `{"tool_name": "Bash", "tool_input": {"command": "git status"}, "cwd": ${deep}}`, false],
    ];
  }

  function typescriptAdapter(text: string, runner: GuardRunner): { code: number; stdout: string } {
    return withEnv(sandboxEnv(), () => runHook(() => Buffer.from(text), runner));
  }

  interface RecordedAdapterRun {
    python: { status: number | null; stdout: string };
    guards: CompletedProcess[];
  }

  function recordedAdapterRun(name: string, text: string): RecordedAdapterRun {
    return recordedAnswers<unknown, RecordedAdapterRun>("codex-guard-depth", [{ name, text }], { "{{ROOT}}": temp })[0] as RecordedAdapterRun;
  }

  it("test_overDeepPayload_matchesPythonAdapter_whenTheRecordedPythonGitGuardAnswerRunsInPlaceOfTheTypescriptOne", () => {
    for (const [name, text] of payloads()) {
      const { python, guards } = recordedAdapterRun(name, text);
      let next = 0;
      const typescript = typescriptAdapter(text, () => {
        next += 1;
        return guards[next - 1] as CompletedProcess;
      });
      if (name in REFUSED_BEFORE_ANY_GUARD) {
        assert.equal(typescript.code, 0, name);
        assert.equal(JSON.parse(typescript.stdout).hookSpecificOutput.permissionDecisionReason, REFUSED_BEFORE_ANY_GUARD[name], name);
        continue;
      }
      assert.equal(typescript.code, python.status, name);
      assert.deepEqual(typescript.stdout === "" ? "" : JSON.parse(typescript.stdout), python.stdout === "" ? "" : JSON.parse(python.stdout), name);
    }
  });

  it("test_overDeepPayload_denyOrPassOnPythonAdapter_thenDeniedWithRecursionReasonOnTypescriptGuard", () => {
    for (const [name, text, deniedForcePush] of payloads()) {
      const { python } = recordedAdapterRun(name, text);
      assert.ok(python.stdout === "" || python.stdout.includes('"permissionDecision": "deny"'), name);
      assert.equal(python.stdout.includes(FORCE_PUSH_REASON), deniedForcePush, name);
      const typescript = typescriptAdapter(text, typescriptGuard);
      assert.equal(typescript.code, 0, name);
      const decision = JSON.parse(typescript.stdout).hookSpecificOutput;
      assert.equal(decision.permissionDecision, "deny", name);
      assert.equal(decision.permissionDecisionReason, REFUSED_BEFORE_ANY_GUARD[name] ?? EXPECTED_DEPTH_DENY_REASON, name);
    }
  });
});
