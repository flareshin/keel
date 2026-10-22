import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { expandUser, glob, splitlines, strip } from "../../hooks/lib/hookkit/pycompat.ts";
import { resolveDirectory, steps, writeTargets } from "../../hooks/lib/hookkit/shell.ts";
import { OSError, run } from "../../hooks/lib/hookkit/subprocess.ts";
import type { CompletedProcess } from "../../hooks/lib/hookkit/subprocess.ts";
import { emit } from "../lib/command.ts";
import type { CommandResult } from "../lib/command.ts";
import { completeEdit, HOOK_CALLER_FRAMES, validateUpdate } from "../lib/config_policy.ts";
import { osErrorMessage, pythonFailureMessage, ValueError } from "../lib/pyerrors.ts";
import { childPath, hasGlobMagic, isStrictAncestor, parentOf, pathExists, purePath, readText, resolvePath, translateNewlines } from "../lib/pyfs.ts";
import { isJsonObject, isTruthy, pythonJsonDumps, pythonJsonLoads } from "../lib/pyjson.ts";
import { decodeStdin, encodeStdout } from "../lib/pystdin.ts";
import { pythonValueStr } from "../lib/pystr.ts";
import type { JsonValue } from "../lib/pyjson.ts";

const KEEL = parentOf(parentOf(parentOf(resolvePath(import.meta.filename))));
const GUARD_TIMEOUT_SECONDS = 35;
const GUARDED_TOOLS = ["Bash", "Edit", "Write"];
const PATCH_PREFIXES = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
const ADAPTER_FILES = ["AGENTS.md", "hooks.json", "keel-codex-state.json"];
const SKILL_REGISTRY_FILES = ["keel-codex-skills.json", "keel-codex-skills.lock"];
const SESSION_FOLDERS = ["sessions", "archived_sessions"];
const GLOB_MARKERS = ["*", "?", "["];

export interface Call {
  tool_name: string;
  tool_input: Record<string, unknown>;
  [field: string]: unknown;
}

export type GuardRunner = (command: readonly string[], input: string) => CompletedProcess;

export function main(readInput: () => Buffer, runner: GuardRunner = spawnGuard): CommandResult {
  try {
    const calls = normalize(pythonJsonLoads(translateNewlines(decodeStdin(readInput()))));
    const contexts: string[] = [];
    for (const call of calls) {
      protectAdapter(call);
      contexts.push(...runGuard("git-guard", call, runner));
      if (call.tool_name === "Bash") contexts.push(...runGuard("ship-gate", call, runner));
    }
    if (contexts.length === 0) return { code: 0, stdout: "", stderr: "" };
    const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contexts.join("\n") } };
    return { code: 0, stdout: pythonJsonDumps(output) + "\n", stderr: "" };
  } catch (error) {
    const message = pythonFailureMessage(error);
    if (message === null) throw error;
    const decision = {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `keel Codex guard: ${message}` },
    };
    return { code: 0, stdout: pythonJsonDumps(decision) + "\n", stderr: "" };
  }
}

export function normalize(payload: unknown): Call[] {
  if (!isJsonObject(payload)) throw new ValueError("payload must be an object");
  const name = payload["tool_name"];
  const tool = payload["tool_input"];
  if (!isJsonObject(tool)) throw new ValueError("tool_input must be an object");
  if (typeof name === "string" && GUARDED_TOOLS.includes(name)) {
    if (name === "Bash" && typeof tool["command"] !== "string") throw new ValueError("Bash command is missing");
    return [payload as Call];
  }
  if (name !== "apply_patch") throw new ValueError(`unsupported guarded tool: ${pythonValueStr(name)}`);
  const patch = tool["command"];
  if (typeof patch !== "string") throw new ValueError("apply_patch command is missing");
  const calls: Call[] = [];
  let path: string | null = null;
  let added: string[] = [];
  for (const line of splitlines(patch)) {
    const prefix = PATCH_PREFIXES.find((item) => line.startsWith(item));
    if (prefix !== undefined) {
      if (path !== null) calls.push(editCall(payload, path, added));
      path = line.slice(prefix.length);
      added = [];
    } else if (line.startsWith("+")) {
      added.push(line.slice(1));
    }
  }
  if (path !== null) calls.push(editCall(payload, path, added));
  if (calls.length === 0) throw new ValueError("apply_patch has no recognized file operations");
  return calls;
}

function editCall(payload: Record<string, unknown>, path: string, added: string[]): Call {
  return { ...payload, tool_name: "Write", tool_input: { file_path: path, content: added.join("\n"), keel_partial: true } };
}

export function protectAdapter(call: Call, accountHome: string = userInfo().homedir): void {
  const home = expandUser("~");
  const profile = resolvePath(purePath(process.env["KEEL_CODEX_HOME"] ?? childPath(home, ".codex")));
  const agentsHome = resolvePath(purePath(process.env["KEEL_AGENTS_HOME"] ?? childPath(home, ".agents")));
  const protectedPaths = new Set([
    ...ADAPTER_FILES.map((name) => resolvePath(childPath(profile, name))),
    ...SKILL_REGISTRY_FILES.map((name) => resolvePath(childPath(agentsHome, name))),
  ]);
  const defaultProfile = childPath(accountHome, ".codex");
  const records = new Set([profile, defaultProfile].flatMap((root) => SESSION_FOLDERS.map((name) => resolvePath(childPath(root, name)))));
  const config = resolvePath(childPath(profile, "config.toml"));
  const cwd = pythonValueStr(isTruthy(call["cwd"]) ? call["cwd"] : process.cwd());
  if (call.tool_name === "Bash") {
    protectShell(call.tool_input["command"] as string, cwd, new Set([...protectedPaths, config]), records);
    return;
  }
  const path = resolvePath(childPath(cwd, filePathOf(call.tool_input)));
  protectRecords(path, records);
  if (protectedPaths.has(path)) {
    throw new ValueError(`generated Codex configuration must be changed through codex/bin/link: ${path}`);
  }
  if (path === config) {
    const candidate = completeEdit(path, call.tool_input);
    validateUpdate(pathExists(path) ? readText(path) : "", candidate, HOOK_CALLER_FRAMES);
  }
}

function filePathOf(tool: Record<string, unknown>): string {
  const filePath = Object.hasOwn(tool, "file_path") ? tool["file_path"] : "";
  if (typeof filePath !== "string") throw new TypeError(`unsupported operand type(s) for /: 'PosixPath' and '${typeof filePath}'`);
  return filePath;
}

function protectRecords(path: string, roots: ReadonlySet<string>): void {
  for (const root of roots) {
    if (path === root || isStrictAncestor(root, path) || isStrictAncestor(path, root)) {
      throw new ValueError("Codex session provenance is read-only to agent tools");
    }
  }
}

function protectShell(command: string, cwd: string, protectedPaths: ReadonlySet<string>, records: ReadonlySet<string>): void {
  for (const step of steps(command, cwd)) {
    const targets = writeTargets(step.command);
    for (const target of [...targets.written, ...targets.removed]) {
      const path = resolvePath(resolveDirectory(step.directory, target, step.expansion));
      protectRecords(shellTargetPrefix(path), records);
      if (hasGlobMagic(path)) {
        for (const matched of glob(path)) protectRecords(resolvePath(matched), records);
      }
      if (protectedPaths.has(path) || Array.from(protectedPaths).some((item) => isStrictAncestor(path, item))) {
        throw new ValueError("shell config edits cannot be verified; use codex/bin/config --file <complete TOML>");
      }
    }
  }
}

function shellTargetPrefix(path: string): string {
  let prefix = "";
  for (const part of path.split("/").filter((item) => item !== "")) {
    if (GLOB_MARKERS.some((marker) => part.includes(marker))) return prefix === "" ? "/" : prefix;
    prefix += "/" + part;
  }
  return path;
}

function guardCommand(name: string): string[] {
  const typescript = childPath(KEEL, `hooks/${name}/${name}.ts`);
  if (pathExists(typescript)) return [process.execPath, typescript];
  return ["python3", childPath(KEEL, `hooks/${name}/${name}.py`)];
}

function spawnGuard(command: readonly string[], input: string): CompletedProcess {
  try {
    return run(command, GUARD_TIMEOUT_SECONDS, { input });
  } catch (error) {
    if (error instanceof OSError) throw new OSError(osErrorMessage(error.code, command[0]), error.code);
    throw error;
  }
}

export function runGuard(name: string, call: Record<string, unknown>, runner: GuardRunner = spawnGuard): string[] {
  const completed = runner(guardCommand(name), pythonJsonDumps(call as JsonValue));
  if (completed.returncode !== 0) throw new ValueError(strip(completed.stderr) || `${name} exited ${completed.returncode}`);
  if (strip(completed.stdout) === "") return [];
  const output = pythonJsonLoads(completed.stdout);
  if (!isJsonObject(output)) throw new ValueError(`${name} returned a non-object response`);
  const specific = Object.hasOwn(output, "hookSpecificOutput") ? output["hookSpecificOutput"] : {};
  if (!isJsonObject(specific)) throw new ValueError(`${name} returned invalid hook output`);
  const context = Object.hasOwn(specific, "additionalContext") ? specific["additionalContext"] : null;
  if (context !== null && typeof context !== "string") throw new ValueError(`${name} returned invalid context`);
  return isTruthy(context) ? [context as string] : [];
}

if (import.meta.main) {
  const result = main(() => readFileSync(0));
  emit({ ...result, stdout: encodeStdout(result.stdout) });
}
