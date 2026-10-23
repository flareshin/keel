import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { run } from "../../hooks/lib/hookkit/subprocess.ts";
import type { CompletedProcess } from "../../hooks/lib/hookkit/subprocess.ts";
import { withEnv } from "../../tests/hooks/helpers.ts";
import { main as runHook } from "../hooks/pre-tool-use.ts";
import type { GuardRunner } from "../hooks/pre-tool-use.ts";
import { EXPECTED_DEPTH_DENY_REASON, JSON_DEPTH_BOUND } from "./json-depth-policy.ts";
import { withoutLocale } from "./locale-env.ts";

const ADAPTER = realpathSync(join(import.meta.dirname, ".."));
const PYTHON_ADAPTER = join(ADAPTER, "hooks", "pre-tool-use.py");
const PYTHON_GIT_GUARD = join(dirname(ADAPTER), "hooks", "git-guard", "git-guard.py");
const GUARD_TIMEOUT_SECONDS = 35;
const PAST_THE_BOUND = 2 * JSON_DEPTH_BOUND;
const FORCE_PUSH_REASON = "F-force-push";

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

  const pythonGuardInPlaceOfTypescript: GuardRunner = (command, input): CompletedProcess =>
    run(command[1]?.endsWith("git-guard.ts") ? ["python3", PYTHON_GIT_GUARD] : command, GUARD_TIMEOUT_SECONDS, { input });

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

  function pythonAdapter(text: string): { status: number | null; stdout: string } {
    const result = spawnSync("python3", [PYTHON_ADAPTER], { input: text, encoding: "utf8", env: { ...withoutLocale(process.env), ...sandboxEnv() } });
    return { status: result.status, stdout: result.stdout };
  }

  function typescriptAdapter(text: string, runner: GuardRunner): { code: number; stdout: string } {
    return withEnv(sandboxEnv(), () => runHook(() => Buffer.from(text), runner));
  }

  it("test_overDeepPayload_matchesPythonAdapter_whenPythonGitGuardRunsInPlaceOfTheTypescriptOne", () => {
    for (const [name, text] of payloads()) {
      const python = pythonAdapter(text);
      const typescript = typescriptAdapter(text, pythonGuardInPlaceOfTypescript);
      assert.equal(typescript.code, python.status, name);
      assert.equal(typescript.stdout, python.stdout, name);
    }
  });

  it("test_overDeepPayload_denyOrPassOnPythonAdapter_thenDeniedWithRecursionReasonOnTypescriptGuard", () => {
    for (const [name, text, deniedForcePush] of payloads()) {
      const python = pythonAdapter(text);
      assert.ok(python.stdout === "" || python.stdout.includes('"permissionDecision": "deny"'), name);
      assert.equal(python.stdout.includes(FORCE_PUSH_REASON), deniedForcePush, name);
      const typescript = typescriptAdapter(text, typescriptGuard);
      assert.equal(typescript.code, 0, name);
      const decision = JSON.parse(typescript.stdout).hookSpecificOutput;
      assert.equal(decision.permissionDecision, "deny", name);
      assert.equal(decision.permissionDecisionReason, EXPECTED_DEPTH_DENY_REASON, name);
    }
  });
});
