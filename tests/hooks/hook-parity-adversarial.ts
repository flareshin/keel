import { join } from "node:path";
import {
  AGENT_ID, basePayload, bash, ENV_PREFLIGHT, GIT_GUARD, HANDOFF, HookSandbox, KEEL_EVIDENCE_LINE, MODEL_ASSIGN, preToolUse, REPORT_GATE, SESSION_ID,
  subagentStop,
} from "./helpers.ts";

const DOTTED_I = "İ";
const DOTLESS_I = "ı";
const LONG_S = "ſ";
const NON_ASCII = /[^\x00-\x7f]/g;
const NON_FINITE_LITERALS = ["NaN", "Infinity", "-Infinity"];
const CLI_RESPONSE = '{"evidence_id":"review-20261011T090000Z-1a2b3c4d","repo":"acme/app","paths":3}';
const DICT_STATE_SESSION = "dict-state";
const DICT_STATE = '{"paths": {"/old/a.py": 1, "/old/b.py": 2}, "ev": false, "hb": false}';
const OVER_LIMIT_INTEGER = "1".repeat(4301);
const DEEP_LEVELS = [3000, 100000];
const UNPROVEN_REPORT = "Done. All good, VERDICT: PASS";
const PYTHON_DUMPS_OVERFLOW_LABEL = "100000-deep objects";
const TRANSCRIPT_DIRECTORY = "json-limit-transcripts";
const BRIEF_ONLY = { type: "user", message: { role: "user", content: "Do the task." } };
const EDIT_OUTSIDE_SCOPE = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/elsewhere/b.py" } }] } };

export interface AdversarialCase {
  name: string;
  script: string;
  stdin: string;
  args: string[];
  cwd: string;
}

export interface AdversarialSet {
  sandbox: HookSandbox;
  cases: AdversarialCase[];
}

export function buildAdversarialSet(): AdversarialSet {
  const sandbox = new HookSandbox();
  sandbox.env["KEEL_CLI"] = sandbox.stub("keel", { stdout: CLI_RESPONSE });
  sandbox.putStubClaudeOnPath();
  sandbox.useExampleOverlay("stack-data/spring-maven/jdk.tsv");
  const repo = sandbox.makeRepo("acmecorp", "billing");
  sandbox.agentTranscript(`[SCOPE] ${join(sandbox.root, "work", "app")}\nDo the task.`);
  sandbox.write(join(sandbox.data, "state", "keel", "report-gate", `${DICT_STATE_SESSION}-${AGENT_ID}.json`), DICT_STATE);
  const cases = [
    ...gitGuardCases(repo),
    ...reportGateCases(sandbox),
    ...envPreflightCases(repo),
    ...modelAssignCases(sandbox.root),
    ...handoffCases(repo),
    ...jsonLimitCases(sandbox, repo),
  ];
  return { sandbox, cases };
}

function asciiJson(payload: unknown): string {
  return JSON.stringify(payload).replace(NON_ASCII, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

function spellings(payload: unknown): string[] {
  return Array.from(new Set([JSON.stringify(payload), asciiJson(payload)]));
}

function casesFor(name: string, script: string, cwd: string, payload: unknown, args: string[] = []): AdversarialCase[] {
  return spellings(payload).map((stdin, index) => ({ name: `${name}#${index}`, script: script.replace(/\.ts$/, ".py"), stdin, args, cwd }));
}

function rawCase(name: string, script: string, cwd: string, stdin: string): AdversarialCase {
  return { name, script: script.replace(/\.ts$/, ".py"), stdin, args: [], cwd };
}

function gitGuardCases(repo: string): AdversarialCase[] {
  const commands = [
    `git commit -m 'Wr${DOTTED_I}tten by Claude'`,
    `git commit -m 'Wr${DOTLESS_I}tten by Claude'`,
    `git commit -m 'Co-Authored-By: Anthrop${DOTLESS_I}c'`,
    `git commit -m 'Generated using Opena${DOTTED_I}'`,
    `git commit -m 'Claude a${LONG_S}${LONG_S}isted'`,
    `git commit -m 'Written by hand ${DOTTED_I} ${DOTLESS_I}'`,
    `git commit -m 'Fix 日本 \u{1F600}' -m 'Co-Authored-By: Claude'`,
    `gh pr create --title x --body 'Generated w${DOTTED_I}th Claude'`,
    ...NON_FINITE_LITERALS.flatMap((literal) => [
      `claude -p hi --settings '{"disableAllHooks": true, "x": ${literal}}'`,
      `claude -p hi --settings '{"disableAll\\u0048ooks": true, "x": ${literal}}'`,
      `claude -p hi --settings '{"disableAll\\u0048ooks": false, "x": ${literal}}'`,
    ]),
  ];
  const unparseable = [
    `{"tool_input": {"command": "git comm${DOTTED_I}t -m x"`,
    `{"tool_input": {"command": "g${DOTTED_I}t push"`,
    `{"tool_input": {"command": "d${DOTLESS_I}sableAllHooks"`,
    `{"tool_input": {"command": "git commit --no-ver${DOTTED_I}fy"`,
    `{"tool_input": {"command": "git commit -m 'café 日本'"`,
  ];
  return [
    ...commands.flatMap((command, index) => casesFor(`git-guard command ${index}`, GIT_GUARD, repo, bash(command, repo))),
    ...unparseable.map((raw, index) => rawCase(`git-guard unparseable ${index}`, GIT_GUARD, repo, raw)),
  ];
}

function reportGateCases(sandbox: HookSandbox): AdversarialCase[] {
  const handback = (message: string, session = SESSION_ID) => ({
    ...preToolUse("SubagentHandback", { message }, sandbox.root, sandbox.mainTranscript(), true), session_id: session,
  });
  const passReport = (evidenceLine: string) => `VERDICT: PASS\nNo findings. 3 files changed, 40 insertions(+).\n${evidenceLine}`;
  const reports = [
    "Done. All good, VERDICT: PASS",
    `Done. VERDICT: PASS, 3 tests pass${DOTLESS_I}ng`,
    `Done. VERDICT: PASS. NOT VER${DOTTED_I}F${DOTTED_I}ED`,
    `Done. VERDICT: PASS, 4 f${DOTLESS_I}les changed`,
    `Done. VERDICT: PASS, ex${DOTLESS_I}t code 0`,
    `Done. VERDICT: PASS \u{1F600} 日本 café, Ran 3 tests`,
    `Done. VERDICT: PASS \u{1F600} 日本 café`,
    ...NON_FINITE_LITERALS.map((literal) => passReport(KEEL_EVIDENCE_LINE.replace('"v":1,', `"v":1,"x":${literal},"y":[${literal}],`))),
    passReport(KEEL_EVIDENCE_LINE.replace('"v":1,', '"v":1,"note":"café \u{1F600}",')),
  ];
  return [
    ...reports.flatMap((report, index) => casesFor(`report-gate report ${index}`, REPORT_GATE, sandbox.root, handback(report))),
    ...casesFor("report-gate dict state", REPORT_GATE, sandbox.root, handback("Done.\nRan 12 tests in 0.4s\nOK", DICT_STATE_SESSION)),
  ];
}

function envPreflightCases(repo: string): AdversarialCase[] {
  const commands = [
    `JAVA_HOME=/opt/temur${DOTTED_I}n-17 mvn test`,
    `JAVA_HOME=/opt/temur${DOTLESS_I}n-17 mvn test`,
    "JAVA_HOME=/opt/jdk-11 mvn test",
    `JAVA_HOME=/opt/café-17 mvn test`,
  ];
  return commands.flatMap((command, index) => casesFor(`env-preflight command ${index}`, ENV_PREFLIGHT, repo, bash(command, repo)));
}

function modelAssignCases(cwd: string): AdversarialCase[] {
  const prompts = [`Review the diff 日本 \u{1F600} ${DOTTED_I} and return a VERDICT line.`, `Find callers of café ${DOTLESS_I}.`];
  const nonFinite = withNonFiniteLiterals(preToolUse("Agent", { description: NEGATIVE_INFINITY_TOKEN, prompt: NAN_TOKEN }, cwd));
  return [
    ...prompts.flatMap((prompt, index) => casesFor(`model-assign prompt ${index}`, MODEL_ASSIGN, cwd, preToolUse("Agent", { description: "Find", prompt }, cwd))),
    rawCase("model-assign non-finite prompt", MODEL_ASSIGN, cwd, nonFinite),
  ];
}

function handoffCases(repo: string): AdversarialCase[] {
  const payload = { ...basePayload("PreCompact", repo, "/data/projects/p/café.jsonl", false), trigger: "auto", custom_instructions: "日本" };
  const nonFinite = withNonFiniteLiterals({ ...payload, trigger: NAN_TOKEN, transcript_path: INFINITY_TOKEN });
  return [
    ...casesFor("handoff auto snapshot", HANDOFF, repo, payload, ["--auto"]),
    { ...rawCase("handoff non-finite trigger", HANDOFF, repo, nonFinite), args: ["--auto"] },
  ];
}

const NAN_TOKEN = "@@NaN@@";
const INFINITY_TOKEN = "@@Infinity@@";
const NEGATIVE_INFINITY_TOKEN = "@@-Infinity@@";

function withNonFiniteLiterals(payload: unknown): string {
  return JSON.stringify(payload)
    .replaceAll(`"${NAN_TOKEN}"`, "NaN")
    .replaceAll(`"${INFINITY_TOKEN}"`, "Infinity")
    .replaceAll(`"${NEGATIVE_INFINITY_TOKEN}"`, "-Infinity");
}

function nestedArrays(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function nestedObjects(depth: number): string {
  return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
}

function extraMembers(): Array<[string, string]> {
  return [
    ["over-limit integer", OVER_LIMIT_INTEGER],
    ["over-limit float", `${OVER_LIMIT_INTEGER}.5`],
    ["deep value before over-limit integer", `[${nestedArrays(DEEP_LEVELS[0] ?? 0)}, ${OVER_LIMIT_INTEGER}]`],
    ...DEEP_LEVELS.flatMap((depth): Array<[string, string]> => [[`${depth}-deep arrays`, nestedArrays(depth)], [`${depth}-deep objects`, nestedObjects(depth)]]),
  ];
}

function withExtraMember(payload: unknown, member: string): string {
  return JSON.stringify(payload).slice(0, -1) + `, "extra": ${member}}`;
}

function jsonLimitPayloadCases(name: string, script: string, cwd: string, payload: unknown, args: string[] = []): AdversarialCase[] {
  const wholeDocuments: Array<[string, string]> = [["whole document over-limit integer", OVER_LIMIT_INTEGER], ...DEEP_LEVELS.map((depth): [string, string] => [`whole document ${depth}-deep arrays`, nestedArrays(depth)])];
  return [
    ...extraMembers().map(([label, member]) => ({ ...rawCase(`${name} ${label}`, script, cwd, withExtraMember(payload, member)), args })),
    ...wholeDocuments.map(([label, document]) => ({ ...rawCase(`${name} ${label}`, script, cwd, document), args })),
  ];
}

function jsonLimitCases(sandbox: HookSandbox, repo: string): AdversarialCase[] {
  return [
    ...jsonLimitPayloadCases("git-guard denying command", GIT_GUARD, repo, bash("git commit -m 'Co-Authored-By: Claude'", repo)),
    ...jsonLimitPayloadCases("git-guard unguarded command", GIT_GUARD, repo, bash("ls", repo)),
    ...jsonLimitPayloadCases("model-assign", MODEL_ASSIGN, sandbox.root, preToolUse("Agent", { description: "Find", prompt: "Review the diff and return a VERDICT line." }, sandbox.root)),
    ...jsonLimitPayloadCases("handoff", HANDOFF, repo, { ...basePayload("PreCompact", repo, "/data/projects/p/t.jsonl", false), trigger: "auto" }, ["--auto"]),
    ...jsonLimitPayloadCases("report-gate handback", REPORT_GATE, sandbox.root, handbackPayload(sandbox, UNPROVEN_REPORT)),
    ...gitGuardSettingsCases(repo),
    ...reportGateEvidenceLineCases(sandbox),
    ...reportGateStateCases(sandbox),
    ...reportGateTranscriptCases(sandbox),
  ];
}

function handbackPayload(sandbox: HookSandbox, message: string): Record<string, unknown> {
  return preToolUse("SubagentHandback", { message }, sandbox.root, sandbox.mainTranscript(), true);
}

function gitGuardSettingsCases(repo: string): AdversarialCase[] {
  const settings = [
    ["over-limit integer", `{"disableAllHooks": false, "n": ${OVER_LIMIT_INTEGER}}`],
    ["over-limit integer without the key", `{"n": ${OVER_LIMIT_INTEGER}}`],
    ...DEEP_LEVELS.flatMap((depth) => [
      [`${depth}-deep value, hooks disabled`, `{"disableAllHooks": true, "x": ${nestedArrays(depth)}}`],
      [`${depth}-deep value, hooks kept`, `{"disableAllHooks": false, "x": ${nestedArrays(depth)}}`],
    ]),
  ];
  return settings.map(([label, text], index) =>
    rawCase(`git-guard settings ${label} ${index}`, GIT_GUARD, repo, JSON.stringify(bash(`claude -p hi --settings '${text}'`, repo))));
}

function reportGateEvidenceLineCases(sandbox: HookSandbox): AdversarialCase[] {
  const passReport = (member: string) => `VERDICT: PASS\nNo findings. 3 files changed, 40 insertions(+).\n${KEEL_EVIDENCE_LINE.replace('"v":1,', `"v":1,"x":${member},`)}`;
  return extraMembers().filter(([label]) => label !== PYTHON_DUMPS_OVERFLOW_LABEL).map(([label, member]) =>
    rawCase(`report-gate evidence line ${label}`, REPORT_GATE, sandbox.root, JSON.stringify(handbackPayload(sandbox, passReport(member)))));
}

function reportGateStateCases(sandbox: HookSandbox): AdversarialCase[] {
  return extraMembers().map(([label, member], index) => {
    const session = `json-limit-state-${index}`;
    sandbox.write(join(sandbox.data, "state", "keel", "report-gate", `${session}-${AGENT_ID}.json`), `{"paths": [], "ev": false, "hb": false, "x": ${member}}`);
    const transcript = sandbox.write(join(sandbox.root, TRANSCRIPT_DIRECTORY, "brief-only.jsonl"), JSON.stringify(BRIEF_ONLY) + "\n");
    const payload = { ...subagentStop(sandbox.root, sandbox.mainTranscript(), transcript, UNPROVEN_REPORT), session_id: session };
    return rawCase(`report-gate state file ${label}`, REPORT_GATE, sandbox.root, JSON.stringify(payload));
  });
}

function reportGateTranscriptCases(sandbox: HookSandbox): AdversarialCase[] {
  const brief = { type: "user", message: { role: "user", content: `[SCOPE] ${join(sandbox.root, "work", "app")}\nDo the task.` } };
  const lines = (poisoned: string, edge: "before" | "after") => {
    const body = [JSON.stringify(brief), JSON.stringify(EDIT_OUTSIDE_SCOPE)];
    body.splice(edge === "before" ? 1 : 2, 0, poisoned);
    return body.join("\n") + "\n";
  };
  return extraMembers().flatMap(([label, member], index) => (["before", "after"] as const).map((edge) => {
    const path = sandbox.write(join(sandbox.root, TRANSCRIPT_DIRECTORY, `${index}-${edge}.jsonl`), lines(`{"type": "system", "extra": ${member}}`, edge));
    const stop = subagentStop(sandbox.root, sandbox.mainTranscript(), path, "Changed it.");
    return rawCase(`report-gate transcript line ${label} ${edge} the edit`, REPORT_GATE, sandbox.root, JSON.stringify(stop));
  }));
}
