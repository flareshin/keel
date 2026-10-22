import { join } from "node:path";
import {
  AGENT_ID, basePayload, bash, ENV_PREFLIGHT, GIT_GUARD, HANDOFF, HookSandbox, KEEL_EVIDENCE_LINE, MODEL_ASSIGN, preToolUse, REPORT_GATE, SESSION_ID,
} from "./helpers.ts";
import { jsonLimitCases } from "./hook-parity-json-limits.ts";
import type { TsOutcome } from "./hook-parity-json-limits.ts";

const DOTTED_I = "İ";
const DOTLESS_I = "ı";
const LONG_S = "ſ";
const NON_ASCII = /[^\x00-\x7f]/g;
const NON_FINITE_LITERALS = ["NaN", "Infinity", "-Infinity"];
const CLI_RESPONSE = '{"evidence_id":"review-20261011T090000Z-1a2b3c4d","repo":"acme/app","paths":3}';
const DICT_STATE_SESSION = "dict-state";
const DICT_STATE = '{"paths": {"/old/a.py": 1, "/old/b.py": 2}, "ev": false, "hb": false}';

export interface AdversarialCase {
  name: string;
  script: string;
  stdin: string;
  args: string[];
  cwd: string;
  divergence?: TsOutcome;
}

export interface AdversarialSet {
  sandbox: HookSandbox;
  cases: AdversarialCase[];
  divergences: Map<string, TsOutcome>;
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
  const divergences = new Map(cases.flatMap((adversarialCase): Array<[string, TsOutcome]> => (adversarialCase.divergence ? [[adversarialCase.name, adversarialCase.divergence]] : [])));
  return { sandbox, cases, divergences };
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
