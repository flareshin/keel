import { join } from "node:path";
import { MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts";
import { AGENT_ID, basePayload, bash, GIT_GUARD, HANDOFF, KEEL_EVIDENCE_LINE, MODEL_ASSIGN, preToolUse, REPORT_GATE, SESSION_ID, subagentStop } from "./helpers.ts";
import type { HookSandbox } from "./helpers.ts";
import type { AdversarialCase } from "./hook-parity-adversarial.ts";

export interface TsOutcome {
  code: number | null;
  stdoutIncludes?: string;
  stdoutEmpty?: true;
  stderrIncludes?: string;
  firesInclude?: string;
}

interface ExtraMember {
  label: string;
  text: string;
  depth: number;
  overLimitInteger?: true;
  pastDoubleRange?: true;
}

interface Stage {
  wrappers: number;
  outcome: TsOutcome;
}

const OVER_LIMIT_INTEGER = "1".repeat(4301);
const DEEP_LEVELS = [3000, 9999, 10001, 140000, 1000000];
const LARGEST_OBJECT_LEVEL = 140000;
const MODEL_ASSIGN_OUTPUT_EXTRA_LEVELS = 1;
const UNPROVEN_REPORT = "Done. All good, VERDICT: PASS";
const TRANSCRIPT_DIRECTORY = "json-limit-transcripts";
const BRIEF_ONLY = { type: "user", message: { role: "user", content: "Do the task." } };
const EDIT_OUTSIDE_SCOPE = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/elsewhere/b.py" } }] } };
const RECURSION = "RecursionError";
const PLACEHOLDER = "@@DEEP@@";
const REFUSED_UNCHECKABLE = "refusing it";
const HANDBACK_REFUSED: TsOutcome = { code: 2, stderrIncludes: REFUSED_UNCHECKABLE, firesInclude: RECURSION };
const STOP_BLOCKED: TsOutcome = { code: 0, stdoutIncludes: '"decision": "block"', firesInclude: RECURSION };
const LOGGED_AND_PASSED: TsOutcome = { code: 0, firesInclude: RECURSION };
const FAILED_CLOSED_DENY: TsOutcome = { code: 2, stderrIncludes: "internal error on a guarded command", firesInclude: RECURSION };
const FAILED_CLOSED_DENY_WITH_LONG_COMMAND: TsOutcome = { code: 2, firesInclude: RECURSION };
const NOT_AN_OBJECT = "hook payload is not a JSON object";
const ATTRIBUTION_DENIED: TsOutcome = { code: 2, stderrIncludes: "AI-tool attribution in the commit message" };
const PASSED_SILENTLY: TsOutcome = { code: 0, stdoutEmpty: true };
const PASSED_AS_NOT_AN_OBJECT: TsOutcome = { code: 0, firesInclude: NOT_AN_OBJECT };
const MODEL_ASSIGNED: TsOutcome = { code: 0, stdoutIncludes: '"model": "opus"' };
const HANDBACK_WITHOUT_TOKEN_REFUSED: TsOutcome = { code: 2, stderrIncludes: "report has no evidence token" };
const STOP_WITHOUT_TOKEN_BLOCKED: TsOutcome = { code: 0, stdoutIncludes: "report has no evidence token" };
const EVIDENCE_REFUSED_AS_NOT_JSON: TsOutcome = { code: 0, firesInclude: "KEEL-EVIDENCE line is not JSON" };
const STOP_OUT_OF_SCOPE_BLOCKED: TsOutcome = { code: 0, stdoutIncludes: "changes outside the brief's scope" };

function nestedArrays(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function nestedObjects(depth: number): string {
  return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
}

function extraMembers(): ExtraMember[] {
  return [
    { label: "over-limit integer", text: OVER_LIMIT_INTEGER, depth: 0, overLimitInteger: true },
    { label: "over-limit float", text: `${OVER_LIMIT_INTEGER}.5`, depth: 0, pastDoubleRange: true },
    { label: "deep value before over-limit integer", text: `[${nestedArrays(3000)}, ${OVER_LIMIT_INTEGER}]`, depth: 3001, overLimitInteger: true },
    ...DEEP_LEVELS.flatMap((depth): ExtraMember[] => [
      { label: `${depth}-deep arrays`, text: nestedArrays(depth), depth },
      ...(depth <= LARGEST_OBJECT_LEVEL ? [{ label: `${depth}-deep objects`, text: nestedObjects(depth), depth }] : []),
    ]),
  ];
}

function divergenceFor(depth: number, stages: readonly Stage[]): TsOutcome | undefined {
  return stages.find((stage) => depth + stage.wrappers > MAX_JSON_DEPTH)?.outcome;
}

function memberDivergence(member: ExtraMember, stages: readonly Stage[], overLimitOutcome?: TsOutcome): TsOutcome | undefined {
  return member.overLimitInteger ? overLimitOutcome : divergenceFor(member.depth, stages);
}

function jsonCase(name: string, script: string, cwd: string, stdin: string, args: string[], divergence?: TsOutcome): AdversarialCase {
  const adversarialCase: AdversarialCase = { name, script, stdin, args, cwd };
  return divergence ? { ...adversarialCase, divergence } : adversarialCase;
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
  documentOutcome: TsOutcome;
  memberOutcome: TsOutcome;
  overLimitMemberOutcome?: TsOutcome;
  overLimitDocumentOutcome?: TsOutcome;
}

function payloadFamilyCases(family: PayloadFamily): AdversarialCase[] {
  const args = family.args ?? [];
  const members = extraMembers().map((member) =>
    jsonCase(`${family.name} ${member.label}`, family.script, family.cwd, withExtraMember(family.payload, member.text), args,
      memberDivergence(member, [{ wrappers: 1, outcome: family.memberOutcome }], family.overLimitMemberOutcome)));
  const documents = [
    jsonCase(`${family.name} whole document over-limit integer`, family.script, family.cwd, OVER_LIMIT_INTEGER, args, family.overLimitDocumentOutcome),
    ...DEEP_LEVELS.map((depth) =>
      jsonCase(`${family.name} whole document ${depth}-deep arrays`, family.script, family.cwd, nestedArrays(depth), args,
        divergenceFor(depth, [{ wrappers: 0, outcome: family.documentOutcome }]))),
  ];
  return [...members, ...documents];
}

export function jsonLimitCases(sandbox: HookSandbox, repo: string): AdversarialCase[] {
  return [
    ...payloadFamilyCases({ name: "git-guard denying command", script: GIT_GUARD, cwd: repo, payload: bash("git commit -m 'Co-Authored-By: Claude'", repo), memberOutcome: FAILED_CLOSED_DENY, documentOutcome: FAILED_CLOSED_DENY, overLimitMemberOutcome: ATTRIBUTION_DENIED, overLimitDocumentOutcome: PASSED_AS_NOT_AN_OBJECT }),
    ...payloadFamilyCases({ name: "git-guard quoted git word", script: GIT_GUARD, cwd: repo, payload: bash("\"g\"it commit -m 'Co-Authored-By: Claude'", repo), memberOutcome: FAILED_CLOSED_DENY, documentOutcome: FAILED_CLOSED_DENY, overLimitMemberOutcome: ATTRIBUTION_DENIED, overLimitDocumentOutcome: PASSED_AS_NOT_AN_OBJECT }),
    ...payloadFamilyCases({ name: "git-guard unguarded command", script: GIT_GUARD, cwd: repo, payload: bash("ls", repo), memberOutcome: FAILED_CLOSED_DENY, documentOutcome: FAILED_CLOSED_DENY, overLimitMemberOutcome: PASSED_SILENTLY, overLimitDocumentOutcome: PASSED_AS_NOT_AN_OBJECT }),
    ...payloadFamilyCases({ name: "model-assign", script: MODEL_ASSIGN, cwd: sandbox.root, payload: modelAssignPayload(sandbox.root), memberOutcome: LOGGED_AND_PASSED, documentOutcome: LOGGED_AND_PASSED, overLimitMemberOutcome: MODEL_ASSIGNED }),
    ...payloadFamilyCases({ name: "handoff", script: HANDOFF, cwd: repo, payload: { ...basePayload("PreCompact", repo, "/data/projects/p/t.jsonl", false), trigger: "auto" }, args: ["--auto"], memberOutcome: LOGGED_AND_PASSED, documentOutcome: LOGGED_AND_PASSED, overLimitMemberOutcome: { code: 0, firesInclude: `"session": "${SESSION_ID}", "detail": "snapshot ` } }),
    ...payloadFamilyCases({ name: "report-gate handback", script: REPORT_GATE, cwd: sandbox.root, payload: handbackPayload(sandbox, UNPROVEN_REPORT), memberOutcome: HANDBACK_REFUSED, documentOutcome: LOGGED_AND_PASSED, overLimitMemberOutcome: HANDBACK_WITHOUT_TOKEN_REFUSED, overLimitDocumentOutcome: PASSED_AS_NOT_AN_OBJECT }),
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
  const stages: Stage[] = [{ wrappers: 2 + MODEL_ASSIGN_OUTPUT_EXTRA_LEVELS, outcome: LOGGED_AND_PASSED }];
  const payload = preToolUse("Agent", { description: "Find", prompt: "Review the diff and return a VERDICT line.", x: PLACEHOLDER }, cwd);
  return levels.flatMap((depth) => [
    { shape: "arrays", text: nestedArrays(depth) },
    ...(depth < LARGEST_OBJECT_LEVEL ? [{ shape: "objects", text: nestedObjects(depth) }] : []),
  ].map(({ shape, text }) =>
    jsonCase(`model-assign tool_input ${depth}-deep ${shape}`, MODEL_ASSIGN, cwd, JSON.stringify(payload).replace(`"${PLACEHOLDER}"`, text), [], divergenceFor(depth, stages))));
}

function gitGuardSettingsCases(repo: string): AdversarialCase[] {
  const settings: Array<[string, string, number]> = [
    ["over-limit integer", `{"disableAllHooks": false, "n": ${OVER_LIMIT_INTEGER}}`, 0],
    ["over-limit integer without the key", `{"n": ${OVER_LIMIT_INTEGER}}`, 0],
    ...DEEP_LEVELS.flatMap((depth): Array<[string, string, number]> => [
      [`${depth}-deep value, hooks disabled`, `{"disableAllHooks": true, "x": ${nestedArrays(depth)}}`, depth],
      [`${depth}-deep value, hooks kept`, `{"disableAllHooks": false, "x": ${nestedArrays(depth)}}`, depth],
      [`${depth}-deep value, hooks disabled, key spelled with an escape`, `{"disable\\u0041llHooks": true, "x": ${nestedArrays(depth)}}`, depth],
      [`${depth}-deep value, hooks kept, key spelled with an escape`, `{"disable\\u0041llHooks": false, "x": ${nestedArrays(depth)}}`, depth],
    ]),
  ];
  return settings.map(([label, text, depth]) =>
    jsonCase(`git-guard settings ${label}`, GIT_GUARD, repo, JSON.stringify(bash(`claude -p hi --settings '${text}'`, repo)), [],
      divergenceFor(depth, [{ wrappers: 1, outcome: FAILED_CLOSED_DENY_WITH_LONG_COMMAND }])));
}

function gitGuardListCommandCases(repo: string): AdversarialCase[] {
  const command = JSON.stringify("'; git commit --no-verify -m x; echo \"");
  const payload = JSON.stringify(bash(PLACEHOLDER, repo));
  const stages: Stage[] = [{ wrappers: 2, outcome: FAILED_CLOSED_DENY_WITH_LONG_COMMAND }];
  return [3, 3000, MAX_JSON_DEPTH - 2, MAX_JSON_DEPTH + 1, 140000].map((depth) =>
    jsonCase(`git-guard command nested in ${depth} lists`, GIT_GUARD, repo, payload.replace(`"${PLACEHOLDER}"`, "[".repeat(depth) + command + "]".repeat(depth)), [], divergenceFor(depth, stages)));
}

function reportGateEvidenceLineCases(sandbox: HookSandbox): AdversarialCase[] {
  const passReport = (member: string) => `VERDICT: PASS\nNo findings. 3 files changed, 40 insertions(+).\n${KEEL_EVIDENCE_LINE.replace('"v":1,', `"v":1,"x":${member},`)}`;
  const stages: Stage[] = [{ wrappers: 2, outcome: LOGGED_AND_PASSED }];
  return extraMembers().map((member) =>
    jsonCase(`report-gate evidence line ${member.label}`, REPORT_GATE, sandbox.root, JSON.stringify(handbackPayload(sandbox, passReport(member.text))), [],
      member.pastDoubleRange ? EVIDENCE_REFUSED_AS_NOT_JSON : divergenceFor(member.depth, stages)));
}

function briefOnlyTranscript(sandbox: HookSandbox): string {
  return sandbox.write(join(sandbox.root, TRANSCRIPT_DIRECTORY, "brief-only.jsonl"), JSON.stringify(BRIEF_ONLY) + "\n");
}

function reportGateStopCases(sandbox: HookSandbox): AdversarialCase[] {
  const payload = subagentStop(sandbox.root, sandbox.mainTranscript(), briefOnlyTranscript(sandbox), UNPROVEN_REPORT);
  return payloadFamilyCases({ name: "report-gate stop", script: REPORT_GATE, cwd: sandbox.root, payload, memberOutcome: STOP_BLOCKED, documentOutcome: LOGGED_AND_PASSED, overLimitMemberOutcome: STOP_WITHOUT_TOKEN_BLOCKED, overLimitDocumentOutcome: PASSED_AS_NOT_AN_OBJECT });
}

function reportGateStateCases(sandbox: HookSandbox): AdversarialCase[] {
  const transcript = briefOnlyTranscript(sandbox);
  return extraMembers().flatMap((member, index) => {
    const session = `json-limit-state-${index}`;
    sandbox.write(join(sandbox.data, "state", "keel", "report-gate", `${session}-${AGENT_ID}.json`), `{"paths": [], "ev": false, "hb": false, "x": ${member.text}}`);
    const stop = { ...subagentStop(sandbox.root, sandbox.mainTranscript(), transcript, UNPROVEN_REPORT), session_id: session };
    const handback = { ...handbackPayload(sandbox, UNPROVEN_REPORT), session_id: session };
    return [
      jsonCase(`report-gate state file ${member.label} at stop`, REPORT_GATE, sandbox.root, JSON.stringify(stop), [], memberDivergence(member, [{ wrappers: 1, outcome: STOP_BLOCKED }], STOP_WITHOUT_TOKEN_BLOCKED)),
      jsonCase(`report-gate state file ${member.label} at handback`, REPORT_GATE, sandbox.root, JSON.stringify(handback), [], divergenceFor(member.depth, [{ wrappers: 1, outcome: HANDBACK_REFUSED }])),
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
    return jsonCase(`report-gate transcript line ${member.label} ${edge} the edit`, REPORT_GATE, sandbox.root, JSON.stringify(stop), [], memberDivergence(member, [{ wrappers: 1, outcome: STOP_BLOCKED }], STOP_OUT_OF_SCOPE_BLOCKED));
  }));
}
