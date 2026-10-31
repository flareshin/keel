import { join } from "node:path";
import { MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts";
import { AGENT_ID, bash, GIT_GUARD, KEEL_EVIDENCE_LINE, MODEL_ASSIGN, preToolUse, REPORT_GATE, subagentStop } from "./helpers.ts";
import type { HookSandbox } from "./helpers.ts";
import type { AdversarialCase } from "./hook-parity-adversarial.ts";

interface ExtraMember {
  label: string;
  text: string;
}

const OVER_LIMIT_INTEGER = "1".repeat(4301);
const DEEP_LEVELS = [3000, 9999, 10001, 140000, 1000000];
const LARGEST_OBJECT_LEVEL = 140000;
const UNPROVEN_REPORT = "Done. All good, VERDICT: PASS";
const TRANSCRIPT_DIRECTORY = "json-limit-transcripts";
const BRIEF_ONLY = { type: "user", message: { role: "user", content: "Do the task." } };
const EDIT_OUTSIDE_SCOPE = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/elsewhere/b.py" } }] } };
const PLACEHOLDER = "@@DEEP@@";

function nestedArrays(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function nestedObjects(depth: number): string {
  return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
}

function extraMembers(): ExtraMember[] {
  return [
    { label: "over-limit integer", text: OVER_LIMIT_INTEGER },
    { label: "over-limit float", text: `${OVER_LIMIT_INTEGER}.5` },
    { label: "deep value before over-limit integer", text: `[${nestedArrays(3000)}, ${OVER_LIMIT_INTEGER}]` },
    ...DEEP_LEVELS.flatMap((depth): ExtraMember[] => [
      { label: `${depth}-deep arrays`, text: nestedArrays(depth) },
      ...(depth <= LARGEST_OBJECT_LEVEL ? [{ label: `${depth}-deep objects`, text: nestedObjects(depth) }] : []),
    ]),
  ];
}

function jsonCase(name: string, script: string, cwd: string, stdin: string, args: string[]): AdversarialCase {
  return { name, script, stdin, args, cwd };
}

function withExtraMember(payload: unknown, member: string): string {
  return JSON.stringify(payload).slice(0, -1) + `, "extra": ${member}}`;
}

interface PayloadFamily {
  name: string;
  script: string;
  cwd: string;
  payload: unknown;
  args?: string[];
}

function payloadFamilyCases(family: PayloadFamily): AdversarialCase[] {
  const args = family.args ?? [];
  const members = extraMembers().map((member) =>
    jsonCase(`${family.name} ${member.label}`, family.script, family.cwd, withExtraMember(family.payload, member.text), args));
  const documents = [
    jsonCase(`${family.name} whole document over-limit integer`, family.script, family.cwd, OVER_LIMIT_INTEGER, args),
    ...DEEP_LEVELS.map((depth) => jsonCase(`${family.name} whole document ${depth}-deep arrays`, family.script, family.cwd, nestedArrays(depth), args)),
  ];
  return [...members, ...documents];
}

export function jsonLimitCases(sandbox: HookSandbox, repo: string): AdversarialCase[] {
  return [
    ...payloadFamilyCases({ name: "git-guard denying command", script: GIT_GUARD, cwd: repo, payload: bash("git commit -m 'Co-Authored-By: Claude'", repo) }),
    ...payloadFamilyCases({ name: "git-guard quoted git word", script: GIT_GUARD, cwd: repo, payload: bash("\"g\"it commit -m 'Co-Authored-By: Claude'", repo) }),
    ...payloadFamilyCases({ name: "git-guard unguarded command", script: GIT_GUARD, cwd: repo, payload: bash("ls", repo) }),
    ...payloadFamilyCases({ name: "model-assign", script: MODEL_ASSIGN, cwd: sandbox.root, payload: modelAssignPayload(sandbox.root) }),
    ...payloadFamilyCases({ name: "report-gate handback", script: REPORT_GATE, cwd: sandbox.root, payload: handbackPayload(sandbox, UNPROVEN_REPORT) }),
    ...modelAssignToolInputCases(sandbox.root),
    ...gitGuardSettingsCases(repo),
    ...gitGuardListCommandCases(repo),
    ...reportGateEvidenceLineCases(sandbox),
    ...reportGateStopCases(sandbox),
    ...reportGateStateCases(sandbox),
    ...reportGateTranscriptCases(sandbox),
  ];
}

function modelAssignPayload(cwd: string): Record<string, unknown> {
  return preToolUse("Agent", { description: "Find", prompt: "Review the diff and return a VERDICT line." }, cwd);
}

function handbackPayload(sandbox: HookSandbox, message: string): Record<string, unknown> {
  return preToolUse("SubagentHandback", { message }, sandbox.root, sandbox.mainTranscript(), true);
}

function modelAssignToolInputCases(cwd: string): AdversarialCase[] {
  const levels = [3000, MAX_JSON_DEPTH - 3, MAX_JSON_DEPTH - 2, MAX_JSON_DEPTH + 1, 140000];
  const payload = preToolUse("Agent", { description: "Find", prompt: "Review the diff and return a VERDICT line.", x: PLACEHOLDER }, cwd);
  return levels.flatMap((depth) => [
    { shape: "arrays", text: nestedArrays(depth) },
    ...(depth < LARGEST_OBJECT_LEVEL ? [{ shape: "objects", text: nestedObjects(depth) }] : []),
  ].map(({ shape, text }) =>
    jsonCase(`model-assign tool_input ${depth}-deep ${shape}`, MODEL_ASSIGN, cwd, JSON.stringify(payload).replace(`"${PLACEHOLDER}"`, text), [])));
}

function gitGuardSettingsCases(repo: string): AdversarialCase[] {
  const settings: Array<[string, string]> = [
    ["over-limit integer", `{"disableAllHooks": false, "n": ${OVER_LIMIT_INTEGER}}`],
    ["over-limit integer without the key", `{"n": ${OVER_LIMIT_INTEGER}}`],
    ...DEEP_LEVELS.flatMap((depth): Array<[string, string]> => [
      [`${depth}-deep value, hooks disabled`, `{"disableAllHooks": true, "x": ${nestedArrays(depth)}}`],
      [`${depth}-deep value, hooks kept`, `{"disableAllHooks": false, "x": ${nestedArrays(depth)}}`],
      [`${depth}-deep value, hooks disabled, key spelled with an escape`, `{"disable\\u0041llHooks": true, "x": ${nestedArrays(depth)}}`],
      [`${depth}-deep value, hooks kept, key spelled with an escape`, `{"disable\\u0041llHooks": false, "x": ${nestedArrays(depth)}}`],
    ]),
  ];
  return settings.map(([label, text]) =>
    jsonCase(`git-guard settings ${label}`, GIT_GUARD, repo, JSON.stringify(bash(`claude -p hi --settings '${text}'`, repo)), []));
}

function gitGuardListCommandCases(repo: string): AdversarialCase[] {
  const command = JSON.stringify("'; git commit --no-verify -m x; echo \"");
  const payload = JSON.stringify(bash(PLACEHOLDER, repo));
  return [3, 3000, MAX_JSON_DEPTH - 2, MAX_JSON_DEPTH + 1, 140000].map((depth) =>
    jsonCase(`git-guard command nested in ${depth} lists`, GIT_GUARD, repo, payload.replace(`"${PLACEHOLDER}"`, "[".repeat(depth) + command + "]".repeat(depth)), []));
}

function reportGateEvidenceLineCases(sandbox: HookSandbox): AdversarialCase[] {
  const passReport = (member: string) => `VERDICT: PASS\nNo findings. 3 files changed, 40 insertions(+).\n${KEEL_EVIDENCE_LINE.replace('"v":1,', `"v":1,"x":${member},`)}`;
  return extraMembers().map((member) =>
    jsonCase(`report-gate evidence line ${member.label}`, REPORT_GATE, sandbox.root, JSON.stringify(handbackPayload(sandbox, passReport(member.text))), []));
}

function briefOnlyTranscript(sandbox: HookSandbox): string {
  return sandbox.write(join(sandbox.root, TRANSCRIPT_DIRECTORY, "brief-only.jsonl"), JSON.stringify(BRIEF_ONLY) + "\n");
}

function reportGateStopCases(sandbox: HookSandbox): AdversarialCase[] {
  const payload = subagentStop(sandbox.root, sandbox.mainTranscript(), briefOnlyTranscript(sandbox), UNPROVEN_REPORT);
  return payloadFamilyCases({ name: "report-gate stop", script: REPORT_GATE, cwd: sandbox.root, payload });
}

function reportGateStateCases(sandbox: HookSandbox): AdversarialCase[] {
  const transcript = briefOnlyTranscript(sandbox);
  return extraMembers().flatMap((member, index) => {
    const session = `json-limit-state-${index}`;
    sandbox.write(join(sandbox.data, "state", "keel", "report-gate", `${session}-${AGENT_ID}.json`), `{"paths": [], "ev": false, "hb": false, "x": ${member.text}}`);
    const stop = { ...subagentStop(sandbox.root, sandbox.mainTranscript(), transcript, UNPROVEN_REPORT), session_id: session };
    const handback = { ...handbackPayload(sandbox, UNPROVEN_REPORT), session_id: session };
    return [
      jsonCase(`report-gate state file ${member.label} at stop`, REPORT_GATE, sandbox.root, JSON.stringify(stop), []),
      jsonCase(`report-gate state file ${member.label} at handback`, REPORT_GATE, sandbox.root, JSON.stringify(handback), []),
    ];
  });
}

function reportGateTranscriptCases(sandbox: HookSandbox): AdversarialCase[] {
  const brief = { type: "user", message: { role: "user", content: `[SCOPE] ${join(sandbox.root, "work", "app")}\nDo the task.` } };
  const lines = (poisoned: string, edge: "before" | "after") => {
    const body = [JSON.stringify(brief), JSON.stringify(EDIT_OUTSIDE_SCOPE)];
    body.splice(edge === "before" ? 1 : 2, 0, poisoned);
    return body.join("\n") + "\n";
  };
  return extraMembers().flatMap((member, index) => (["before", "after"] as const).map((edge) => {
    const path = sandbox.write(join(sandbox.root, TRANSCRIPT_DIRECTORY, `${index}-${edge}.jsonl`), lines(`{"type": "system", "extra": ${member.text}}`, edge));
    const stop = subagentStop(sandbox.root, sandbox.mainTranscript(), path, "Changed it.");
    return jsonCase(`report-gate transcript line ${member.label} ${edge} the edit`, REPORT_GATE, sandbox.root, JSON.stringify(stop), []);
  }));
}
