import { join } from "node:path";
import {
  AGENT_ID, basePayload, bash, ENV_PREFLIGHT, GIT_GUARD, HANDOFF, MODEL_ASSIGN, preToolUse, REPORT_GATE, SESSION_ID, SHIP_GATE, subagentStop,
} from "./helpers.ts";
import type { HookSandbox } from "./helpers.ts";
import type { AdversarialCase } from "./hook-parity-adversarial.ts";

type Value = readonly [label: string, value: unknown];

export const NOT_TEXT: readonly Value[] = [
  ["object", { k: "v" }], ["list", ["x"]], ["number", 5], ["zero", 0], ["true", true], ["false", false],
  ["empty list", []], ["empty object", {}], ["null", null],
];
export const NOT_FLAG: readonly Value[] = [
  ["true", true], ["false", false], ["string", "yes"], ["empty string", ""], ["object", { k: 1 }], ["empty object", {}],
  ["number", 1], ["zero", 0], ["list", [1]], ["empty list", []], ["null", null],
];
const NOT_LIST: readonly Value[] = [
  ["string", "text"], ["object", { new_string: "text" }], ["number", 5], ["zero", 0], ["true", true], ["false", false],
  ["empty string", ""], ["empty object", {}], ["null", null],
];

const DIRECTORY = "wrong-type-transcripts";
const DENIED_COMMIT = "git commit -m 'Written by Claude'";
const DENIED_MVN = "JAVA_HOME=/opt/jdk-11 mvn test";
const PUSH = "git push origin main";
const UNPROVEN_REPORT = "Done. All good, VERDICT: PASS";
const SCOPE_BRIEF = (root: string) => ({ type: "user", message: { role: "user", content: `[SCOPE] ${join(root, "work", "app")}\nDo the task.` } });
const toolUse = (name: unknown, input: unknown) => ({
  type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input }] },
});
const EDIT_ELSEWHERE = toolUse("Edit", { file_path: "/elsewhere/b.py" });
const RECORDED_AS_REPR: ReadonlyMap<string, string> = new Map([
  ["number", "5"], ["true", "True"], ["list", "['x']"], ["object", "{'k': 'v'}"],
]);

function casesFor(name: string, script: string, cwd: string, payload: unknown, args: string[] = []): AdversarialCase[] {
  return [{ name, script, stdin: JSON.stringify(payload), args, cwd }];
}

function varied(family: string, script: string, cwd: string, values: readonly Value[], build: (value: unknown) => unknown, args: string[] = []): AdversarialCase[] {
  return values.flatMap(([label, value]) => casesFor(`${family} ${label}`, script, cwd, build(value), args));
}

function writeTranscript(sandbox: HookSandbox, name: string, entries: readonly unknown[]): string {
  return sandbox.write(join(sandbox.root, DIRECTORY, `${name}.jsonl`), entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
}

export function wrongTypeCases(sandbox: HookSandbox, repo: string): AdversarialCase[] {
  return [
    ...gitGuardCases(sandbox, repo),
    ...shipGateCases(repo),
    ...envPreflightCases(repo),
    ...modelAssignCases(sandbox),
    ...handoffCases(repo),
    ...reportGateCases(sandbox),
  ];
}

function gitGuardCases(sandbox: HookSandbox, repo: string): AdversarialCase[] {
  const root = sandbox.root;
  const from: Array<[string, string]> = [["overlay", sandbox.overlay], ["protected store", join(sandbox.data, "state", "keel")], ["repo", repo]];
  const targets: Array<[string, string]> = [
    ["overlay", join(sandbox.overlay, "ledger.tsv")], ["protected store", join(sandbox.data, "state", "keel", "x.json")], ["repo", join(repo, "README.txt")],
  ];
  const absoluteNotebookTargets: Array<[string, string]> = [
    ["overlay", join(sandbox.overlay, "ledger.tsv")], ["protected store", join(sandbox.data, "state", "keel", "x.json")],
  ];
  const guarded: Value[] = [["guarded list", ["git", "commit", "-m", "Written by Claude"]], ["guarded object", { cmd: DENIED_COMMIT }]];
  const family = (name: string, values: readonly Value[], build: (value: unknown) => unknown, cwd = repo) =>
    varied(`git-guard wrong-type ${name}`, GIT_GUARD, cwd, values, build);
  return [
    ...family("command", [...NOT_TEXT, ...guarded], (value) => preToolUse("Bash", { command: value }, repo)),
    ...family("cwd", NOT_TEXT, (value) => ({ ...bash(DENIED_COMMIT, repo), cwd: value })),
    ...family("tool_name", NOT_TEXT, (value) => ({ ...bash(DENIED_COMMIT, repo), tool_name: value })),
    ...from.flatMap(([where, directory]) => [
      ...family(`file_path from ${where}`, NOT_TEXT, (value) => preToolUse("Write", { file_path: value, content: "x" }, directory), root),
      ...family(`notebook_path from ${where}`, NOT_TEXT, (value) => preToolUse("NotebookEdit", { notebook_path: value, new_source: "x" }, directory), root),
      ...family(`file_path with notebook_path from ${where}`, NOT_TEXT, (value) => preToolUse("NotebookEdit", { file_path: value, notebook_path: "n.ipynb", new_source: "x" }, directory), root),
    ]),
    ...absoluteNotebookTargets.flatMap(([where, notebook]) =>
      family(`file_path with absolute notebook_path in ${where}`, NOT_TEXT, (value) => preToolUse("Edit", { file_path: value, notebook_path: notebook, old_string: "a", new_string: "b" }, repo), root)),
    ...targets.flatMap(([where, target]) =>
      family(`edits on ${where}`, NOT_LIST, (value) => preToolUse("MultiEdit", { file_path: target, edits: value }, root), root)),
  ];
}

function shipGateCases(repo: string): AdversarialCase[] {
  const family = (name: string, values: readonly Value[], build: (value: unknown) => unknown) =>
    varied(`ship-gate wrong-type ${name}`, SHIP_GATE, repo, values, build);
  const guarded: Value[] = [["guarded list", ["git", "push", "origin", "main"]], ["guarded object", { cmd: PUSH }]];
  return [
    ...family("command", [...NOT_TEXT, ...guarded], (value) => preToolUse("Bash", { command: value }, repo)),
    ...family("cwd", NOT_TEXT, (value) => ({ ...bash(PUSH, repo), cwd: value })),
    ...family("session_id", NOT_TEXT, (value) => ({ ...bash(PUSH, repo), session_id: value })),
    ...family("hook_event_name", NOT_TEXT, (value) => ({ ...bash(PUSH, repo), hook_event_name: value })),
    ...family("tool_name", NOT_TEXT, (value) => ({ ...bash(PUSH, repo), tool_name: value })),
  ];
}

function envPreflightCases(repo: string): AdversarialCase[] {
  const family = (name: string, values: readonly Value[], build: (value: unknown) => unknown) =>
    varied(`env-preflight wrong-type ${name}`, ENV_PREFLIGHT, repo, values, build);
  const guarded: Value[] = [["guarded list", ["mvn", "test"]], ["guarded object", { cmd: "mvn test" }]];
  return [
    ...family("command", [...NOT_TEXT, ...guarded], (value) => preToolUse("Bash", { command: value }, repo)),
    ...family("cwd", NOT_TEXT, (value) => ({ ...bash(DENIED_MVN, repo), cwd: value })),
    ...family("tool_name", NOT_TEXT, (value) => ({ ...bash(DENIED_MVN, repo), tool_name: value })),
  ];
}

function modelAssignCases(sandbox: HookSandbox): AdversarialCase[] {
  const root = sandbox.root;
  const agent = (extra: Record<string, unknown>) => preToolUse("Agent", { description: "Find", prompt: "Review the diff and return a VERDICT line.", ...extra }, root);
  const family = (name: string, values: readonly Value[], build: (value: unknown) => unknown) =>
    varied(`model-assign wrong-type ${name}`, MODEL_ASSIGN, root, values, build);
  const script = "agent({ prompt: 'x' })";
  const holdsOpus: Value[] = [["object holding a model name", { x: "opus" }], ["list holding a model name", ["sonnet"]]];
  return [
    ...family("subagent_type", NOT_TEXT, (value) => agent({ subagent_type: value })),
    ...family("prompt", NOT_TEXT, (value) => preToolUse("Agent", { description: "Find", prompt: value }, root)),
    ...family("description", NOT_TEXT, (value) => preToolUse("Agent", { description: value, prompt: "Review the diff and return a VERDICT line." }, root)),
    ...family("model", [...NOT_TEXT, ...holdsOpus], (value) => agent({ model: value })),
    ...family("effort", [...NOT_TEXT, ["string", "high"], ["empty string", ""]], (value) => agent({ effort: value })),
    ...family("resumeFromRunId", NOT_FLAG, (value) => preToolUse("Workflow", { script, resumeFromRunId: value }, root)),
    ...family("scriptPath", NOT_TEXT, (value) => preToolUse("Workflow", { script, scriptPath: value }, root)),
  ];
}

function handoffCases(repo: string): AdversarialCase[] {
  const compaction = (extra: Record<string, unknown>) => ({ ...basePayload("PreCompact", repo, "/data/projects/p/t.jsonl", false), trigger: "auto", ...extra });
  const family = (name: string, values: readonly Value[], build: (value: unknown) => unknown) =>
    varied(`handoff wrong-type ${name}`, HANDOFF, repo, values, build, ["--auto"]);
  return [
    ...family("cwd", NOT_TEXT, (value) => compaction({ cwd: value })),
    ...family("trigger", NOT_TEXT, (value) => compaction({ trigger: value })),
    ...family("transcript_path", NOT_TEXT, (value) => compaction({ transcript_path: value })),
  ];
}

function reportGateCases(sandbox: HookSandbox): AdversarialCase[] {
  const root = sandbox.root;
  const brief = SCOPE_BRIEF(root);
  const inScope = join(root, "work", "app", "x.py");
  const family = (name: string, values: readonly Value[], build: (value: unknown) => unknown) =>
    varied(`report-gate wrong-type ${name}`, REPORT_GATE, root, values, build);
  const stop = (transcript: string, message = "Changed it.") => subagentStop(root, sandbox.mainTranscript(), transcript, message);
  const handback = (extra: Record<string, unknown>) => ({
    ...preToolUse("SubagentHandback", { message: UNPROVEN_REPORT }, root, sandbox.mainTranscript(), true), ...extra,
  });
  const outside = writeTranscript(sandbox, "outside-scope", [brief, EDIT_ELSEWHERE]);
  const briefOnly = writeTranscript(sandbox, "brief-only", [brief]);
  const editedInScope = sandbox.write(
    join(sandbox.data, "projects", "-work-app", SESSION_ID, "subagents", "workflows", "wf-1", "agent-wrong-type-edited.jsonl"),
    [brief, toolUse("Edit", { file_path: inScope })].map((entry) => JSON.stringify(entry) + "\n").join(""));
  return [
    ...family("stop_hook_active", NOT_FLAG, (value) => ({ ...stop(outside), stop_hook_active: value })),
    ...family("state ev at handback", NOT_FLAG, (value) => handback({ session_id: stateSession(sandbox, "ev", value) })),
    ...family("state hb at stop", NOT_FLAG, (value) => ({ ...stop(briefOnly, UNPROVEN_REPORT), session_id: stateSession(sandbox, "hb", value) })),
    ...family("message", [...NOT_TEXT, ["object holding evidence", { a: "Ran 3 tests" }]], (value) => ({
      ...preToolUse("SubagentHandback", { message: value }, root, sandbox.mainTranscript(), true), agent_id: "wrong-type-edited",
    })),
    ...identityCases(sandbox, brief, outside),
    ...transcriptEntryCases(sandbox, brief, stop),
  ];
}

function stateSession(sandbox: HookSandbox, field: "ev" | "hb", value: unknown): string {
  const session = `wrong-type-${field}-${JSON.stringify(value)}`.replace(/[^A-Za-z0-9]/g, "-");
  const state = { paths: [], ev: field === "ev" ? value : false, hb: field === "hb" ? value : false };
  sandbox.write(join(sandbox.data, "state", "keel", "report-gate", `${session}-${AGENT_ID}.json`), JSON.stringify(state));
  return session;
}

function identityCases(sandbox: HookSandbox, brief: unknown, outside: string): AdversarialCase[] {
  const root = sandbox.root;
  const transcriptLines = [brief, EDIT_ELSEWHERE].map((entry) => JSON.stringify(entry) + "\n").join("");
  const handback = (extra: Record<string, unknown>) => ({
    ...preToolUse("SubagentHandback", { message: "Done. Changed it." }, root, sandbox.mainTranscript(), true), ...extra,
  });
  for (const repr of RECORDED_AS_REPR.values()) {
    sandbox.write(join(sandbox.data, "projects", "-work-app", SESSION_ID, "subagents", `agent-${repr}.jsonl`), transcriptLines);
    sandbox.write(join(sandbox.data, "projects", "-work-app", repr, "subagents", `agent-${AGENT_ID}.jsonl`), transcriptLines);
  }
  sandbox.write(join(root, SESSION_ID, "subagents", `agent-${AGENT_ID}.jsonl`), transcriptLines);
  const family = (name: string, build: (value: unknown) => unknown) =>
    varied(`report-gate wrong-type ${name}`, REPORT_GATE, root, NOT_TEXT, build);
  return [
    ...family("agent_id at handback", (value) => handback({ agent_id: value })),
    ...family("transcript_path at handback", (value) => handback({ transcript_path: value })),
    ...family("agent_transcript_path at stop", (value) => ({ ...subagentStop(root, sandbox.mainTranscript(), outside, "Changed it."), agent_transcript_path: value })),
    ...family("session_id at handback with a transcript", (value) => handback({ session_id: value })),
  ];
}

function transcriptEntryCases(sandbox: HookSandbox, brief: unknown, stop: (transcript: string) => unknown): AdversarialCase[] {
  const family = (name: string, values: readonly Value[], entry: (value: unknown) => unknown) =>
    values.flatMap(([label, value]) => (["alone", "before an outside edit"] as const).flatMap((position) => {
      const entries = position === "alone" ? [brief, entry(value)] : [brief, entry(value), EDIT_ELSEWHERE];
      const path = writeTranscript(sandbox, `${name}-${label}-${position}`.replace(/[^A-Za-z0-9-]/g, "-"), entries);
      return casesFor(`report-gate wrong-type transcript ${name} ${label} ${position}`, REPORT_GATE, sandbox.root, stop(path));
    }));
  const roles: Value[] = [["number", 5], ["true", true], ["list", ["x"]], ["object", { k: "v" }], ["zero", 0], ["false", false], ["empty string", ""], ["null", null]];
  return [
    ...family("tool name", NOT_TEXT, (value) => toolUse(value, { file_path: "/elsewhere/b.py" })),
    ...family("bash command", NOT_TEXT, (value) => toolUse("Bash", { command: value })),
    ...family("file_path", NOT_TEXT, (value) => toolUse("Edit", { file_path: value })),
    ...family("notebook_path", NOT_TEXT, (value) => toolUse("NotebookEdit", { notebook_path: value })),
    ...family("role", roles, (value) => ({ type: "assistant", message: { role: value, content: EDIT_ELSEWHERE.message.content } })),
  ];
}
