import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const KEEL_HOME = realpathSync(join(import.meta.dirname, "..", ".."));

export function withEnv<T>(changes: Record<string, string | null>, body: () => T, options: { clear?: boolean } = {}): T {
  const saved = { ...process.env };
  try {
    if (options.clear) for (const name of Object.keys(process.env)) delete process.env[name];
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    return body();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

export class Sandbox {
  readonly root: string;
  readonly data: string;
  readonly overlay: string;
  readonly home: string;

  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "keel-hookkit-")));
    this.data = join(this.root, "data");
    this.overlay = join(this.root, "overlay");
    this.home = join(this.root, "home");
    for (const path of [this.data, this.overlay, this.home]) mkdirSync(path);
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  write(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  stubClaude(version = "9.9.9"): string {
    const path = this.write(join(this.root, "stubs", "claude"), `#!/bin/bash\necho '${version} (Claude Code)'\n`);
    chmodSync(path, 0o755);
    return dirname(path) + delimiter + (process.env["PATH"] ?? "/usr/bin:/bin");
  }
}

export const EXAMPLES = join(KEEL_HOME, "examples", "hooks");
export const REPORT_GATE = "hooks/report-gate/report-gate.ts";
export const GIT_GUARD = "hooks/git-guard/git-guard.ts";
export const MODEL_ASSIGN = "hooks/model-assign/model-assign.ts";
export const HANDOFF = "hooks/handoff/handoff.ts";
export const ENV_PREFLIGHT = "stacks/spring-maven/hooks/env-preflight.ts";
export const SESSION_ID = "11111111-2222-3333-4444-555555555555";
export const AGENT_ID = "a1b2c3d4e5f6";
export const SEEDED_RULE_IDS: ReadonlySet<string> = new Set([
  "K1", "K2", "K3", "K4", "K5", "risk", "F-irreversible", "F-secrets", "F-attribution",
  "F-force-push", "F-hookskip", "C-dispatch", "C-handoff", "C-isolation", "S-jdk",
]);

export const KEEL_EVIDENCE_LINE =
  'KEEL-EVIDENCE: {"v":1,"repo_root":"/work/app","review_base":"' + "a".repeat(40) + '","head":null,"snapshot_tree":"' + "b".repeat(40) +
  '","since":null,"run_id":"rv-20261011T085500Z-7f3e21","root_run_id":"rv-20261011T085500Z-7f3e21","review_kind":"lens-review"}';

const HOOK_TIMEOUT_MS = 60_000;
const GIT_CONFIG = "[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n";
const STUB_SOURCE = (record: string, stdout: string, exitCode: number) =>
  `#!${process.execPath}\nconst { appendFileSync, readFileSync } = require("node:fs");\n` +
  `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, "utf8") }) + "\\n");\n` +
  `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exitCode = ${exitCode};\n`;

export interface Fire {
  rule_id: string;
  outcome: string;
  hook: string;
  detail?: string;
  [key: string]: unknown;
}

export interface StubCall {
  argv: string[];
  stdin: string;
}

export class HookResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(code: number | null, stdout: string, stderr: string) {
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  json(): any {
    return JSON.parse(this.stdout);
  }
}

export interface HookRun {
  payload?: unknown;
  args?: string[];
  cwd?: string;
  raw?: string;
}

export class HookSandbox extends Sandbox {
  readonly gitconfig: string;
  readonly env: Record<string, string>;

  constructor() {
    super();
    this.gitconfig = join(this.root, "gitconfig");
    writeFileSync(this.gitconfig, GIT_CONFIG);
    this.env = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !name.startsWith("KEEL_") && !name.startsWith("GIT_")) this.env[name] = value;
    }
    Object.assign(this.env, {
      KEEL_HOME, KEEL_DATA_DIR: this.data, KEEL_OVERLAY_DIR: this.overlay, HOME: this.home,
      GIT_CONFIG_GLOBAL: this.gitconfig, GIT_CONFIG_NOSYSTEM: "1",
    });
    this.env["KEEL_GH"] = this.stub("gh", { stdout: "{}" });
  }

  runHook(script: string, run: HookRun = {}): HookResult {
    const stdin = run.raw ?? (run.payload === undefined ? "" : JSON.stringify(run.payload));
    const completed = spawnSync(process.execPath, [join(KEEL_HOME, script), ...(run.args ?? [])], {
      input: stdin, encoding: "utf8", env: this.env, cwd: run.cwd ?? this.root, timeout: HOOK_TIMEOUT_MS,
    });
    return new HookResult(completed.status, completed.stdout, completed.stderr);
  }

  fires(): Fire[] {
    const path = join(this.data, "logs", "keel-fires.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Fire);
  }

  useExampleOverlay(relative: string): void {
    const target = join(this.overlay, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(EXAMPLES, relative), target);
  }

    stub(name: string, options: { stdout?: string; exitCode?: number } = {}): string {
    const path = join(this.root, "stubs", name);
    this.write(path, STUB_SOURCE(path + ".calls", options.stdout ?? "", options.exitCode ?? 0));
    chmodSync(path, 0o755);
    return path;
  }

  stubCalls(name: string): StubCall[] {
    const record = join(this.root, "stubs", name + ".calls");
    if (!existsSync(record)) return [];
    return readFileSync(record, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as StubCall);
  }

  putStubClaudeOnPath(version = "9.9.9"): void {
    this.env["PATH"] = this.stubClaude(version);
  }

  git(cwd: string, ...args: string[]): string {
    const completed = spawnSync("git", args, { cwd, encoding: "utf8", env: this.env });
    if (completed.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${completed.stderr}`);
    return completed.stdout.trim();
  }

    makeRepo(owner: string, name: string): string {
    const remote = join(this.root, "remotes", owner, name + ".git");
    mkdirSync(remote, { recursive: true });
    this.git(remote, "init", "--bare", "-q");
    const clone = join(this.root, "work", owner, name);
    mkdirSync(dirname(clone), { recursive: true });
    this.git(this.root, "clone", "-q", remote, clone);
    this.write(join(clone, "README.txt"), "start\n");
    this.git(clone, "add", "README.txt");
    this.git(clone, "commit", "-q", "-m", "Start");
    this.git(clone, "push", "-q", "-u", "origin", "main");
    return clone;
  }

  commitFile(repo: string, relative: string, text: string, message: string): void {
    this.write(join(repo, relative), text);
    this.git(repo, "add", relative);
    this.git(repo, "commit", "-q", "-m", message);
  }

  mainTranscript(): string {
    return join(this.data, "projects", "-work-app", SESSION_ID + ".jsonl");
  }

    agentTranscript(brief: string, toolUses: ReadonlyArray<readonly [string, unknown]> = [], subdir = "workflows/wf-1"): string {
    const path = join(this.data, "projects", "-work-app", SESSION_ID, "subagents", subdir, `agent-${AGENT_ID}.jsonl`);
    const lines: unknown[] = [{ type: "user", message: { role: "user", content: brief } }];
    for (const [name, input] of toolUses) {
      lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input }] } });
    }
    this.write(path, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    this.write(this.mainTranscript(), "");
    return path;
  }
}

export function basePayload(event: string, cwd: string, transcriptPath: string, inSubagent: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: SESSION_ID, transcript_path: transcriptPath, cwd, permission_mode: "default", hook_event_name: event,
  };
  if (inSubagent) Object.assign(payload, { agent_id: AGENT_ID, agent_type: "general-purpose" });
  return payload;
}

export function preToolUse(toolName: string, toolInput: unknown, cwd: string, transcriptPath = "/dev/null", inSubagent = false): Record<string, unknown> {
  return { ...basePayload("PreToolUse", cwd, transcriptPath, inSubagent), tool_name: toolName, tool_input: toolInput, tool_use_id: "toolu_01" };
}

export function bash(command: string, cwd: string): Record<string, unknown> {
  return preToolUse("Bash", { command, description: "test" }, cwd);
}

export function subagentStop(cwd: string, transcriptPath: string, agentTranscriptPath: string, message: string | null, stopHookActive = false): Record<string, unknown> {
  const payload = basePayload("SubagentStop", cwd, transcriptPath, true);
  Object.assign(payload, { agent_transcript_path: agentTranscriptPath, stop_hook_active: stopHookActive });
  if (message !== null) payload["last_assistant_message"] = message;
  return payload;
}

export function assertFired(sandbox: HookSandbox, ruleId: string, outcome: string, hook: string): Fire[] {
  const matching = sandbox.fires().filter((fire) => fire.rule_id === ruleId && fire.outcome === outcome && fire.hook === hook);
  assert.ok(matching.length > 0, `no ${ruleId}/${outcome} fire from ${hook} in ${JSON.stringify(sandbox.fires())}`);
  return matching;
}

export function assertBulletIdsSeeded(message: string, overlayIds: Iterable<string> = []): void {
  const allowed = new Set([...SEEDED_RULE_IDS, ...overlayIds]);
  const bullets = message.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(bullets.length > 0, `message has no bullet lines: ${JSON.stringify(message)}`);
  for (const line of bullets) {
    const ruleId = line.startsWith("- [") ? line.slice(3, line.indexOf("]")) : null;
    assert.ok(ruleId !== null && allowed.has(ruleId), line);
  }
}
