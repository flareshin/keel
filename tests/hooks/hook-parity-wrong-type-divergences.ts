import type { TsOutcome } from "./hook-parity-json-limits.ts";

const JSON_TYPE_OF_LABEL: ReadonlyMap<string, string> = new Map([
  ["object", "object"], ["empty object", "object"], ["object holding evidence", "object"], ["object holding a model name", "object"], ["guarded object", "object"],
  ["list", "list"], ["empty list", "list"], ["list holding a model name", "list"], ["guarded list", "list"],
  ["number", "number"], ["zero", "number"], ["true", "boolean"], ["false", "boolean"],
]);
const WRONG_TYPE_LABELS = ["object", "empty object", "list", "empty list", "number", "zero", "true", "false"];
const TRUTHY_WRONG_TYPE_LABELS = ["object", "list", "number", "true"];
const FALSY_WRONG_TYPE_LABELS = ["zero", "false", "empty list", "empty object"];
const NOT_TRUE_LABELS = ["string", "object", "number", "list"];
const GUARDED_LABELS = ["guarded list", "guarded object"];
const POSITIONS = ["alone", "before an outside edit"];
const REFUSED_REPORT = "could not read this report";
const WORKFLOW_DENIED = "workflow agents need a model and an effort";
const NOT_A_PATH = "(a path that is not text)";

type Rule = readonly [family: string, labels: readonly string[], outcome: (label: string) => TsOutcome];

function typeOf(label: string): string {
  return JSON_TYPE_OF_LABEL.get(label) ?? label;
}

function readFailure(field: string, code: number, extra: Partial<TsOutcome> = {}): (label: string) => TsOutcome {
  return (label) => ({ code, firesInclude: `FieldTypeError: ${field} must be a string, not ${typeOf(label)}`, ...extra });
}

function judgedWhereTheCallStarts(rule: string): (label: string) => TsOutcome {
  return () => ({ code: 2, stderrIncludes: `[${rule}] git-guard: blocked`, firesInclude: NOT_A_PATH });
}

function judgedByTheNotebookPath(rule: string): (label: string) => TsOutcome {
  return () => ({ code: 2, stderrIncludes: `[${rule}] git-guard: blocked` });
}

function pathRules(name: string, field: string, labels: readonly string[]): Rule[] {
  return [
    [`git-guard wrong-type ${name} from overlay`, labels, judgedWhereTheCallStarts("C-isolation")],
    [`git-guard wrong-type ${name} from protected store`, labels, judgedWhereTheCallStarts("K1")],
    [`git-guard wrong-type ${name} from repo`, WRONG_TYPE_LABELS, readFailure(field, 0)],
  ];
}

function perPosition(labels: readonly string[]): string[] {
  return labels.flatMap((label) => POSITIONS.map((position) => `${label} ${position}`));
}

const RULES: readonly Rule[] = [
  ["git-guard wrong-type command", WRONG_TYPE_LABELS, readFailure("command", 0)],
  ["git-guard wrong-type command", GUARDED_LABELS, readFailure("command", 2, { stderrIncludes: "internal error on a guarded command" })],
  ["git-guard wrong-type cwd", TRUTHY_WRONG_TYPE_LABELS, () => ({ code: 2, stderrIncludes: "[F-attribution] git-guard: blocked" })],
  ...pathRules("file_path", "file_path", [...TRUTHY_WRONG_TYPE_LABELS, ...FALSY_WRONG_TYPE_LABELS]),
  ...pathRules("notebook_path", "notebook_path", [...TRUTHY_WRONG_TYPE_LABELS, ...FALSY_WRONG_TYPE_LABELS]),
  ["git-guard wrong-type file_path with notebook_path from overlay", WRONG_TYPE_LABELS, judgedWhereTheCallStarts("C-isolation")],
  ["git-guard wrong-type file_path with notebook_path from protected store", WRONG_TYPE_LABELS, judgedWhereTheCallStarts("K1")],
  ["git-guard wrong-type file_path with notebook_path from repo", WRONG_TYPE_LABELS, readFailure("file_path", 0)],
  ["git-guard wrong-type file_path with absolute notebook_path in overlay", TRUTHY_WRONG_TYPE_LABELS, judgedByTheNotebookPath("C-isolation")],
  ["git-guard wrong-type file_path with absolute notebook_path in protected store", TRUTHY_WRONG_TYPE_LABELS, judgedByTheNotebookPath("K1")],
  ["git-guard wrong-type edits on repo", ["zero", "false", "empty string", "empty object"], () => ({ code: 0, firesInclude: "TypeError: edits is not a list" })],
  ["ship-gate wrong-type command", WRONG_TYPE_LABELS, () => ({ code: 0, stderrIncludes: "FieldTypeError: command must be a string" })],
  ["ship-gate wrong-type command", GUARDED_LABELS, () => ({ code: 2, stderrIncludes: "FieldTypeError: command must be a string" })],
  ["ship-gate wrong-type cwd", [...TRUTHY_WRONG_TYPE_LABELS, ...FALSY_WRONG_TYPE_LABELS], () => ({ code: 2, stderrIncludes: "FieldTypeError: cwd must be a string" })],
  ["ship-gate wrong-type session_id", TRUTHY_WRONG_TYPE_LABELS, () => ({ code: 0, firesInclude: '"session":"-"' })],
  ["env-preflight wrong-type command", [...WRONG_TYPE_LABELS, ...GUARDED_LABELS], readFailure("command", 0)],
  ["env-preflight wrong-type cwd", TRUTHY_WRONG_TYPE_LABELS, () => ({ code: 2, stderrIncludes: "[S-jdk] env-preflight: mvn in acmecorp/billing" })],
  ...["subagent_type", "prompt", "description"].map((field): Rule => [`model-assign wrong-type ${field}`, WRONG_TYPE_LABELS, readFailure(field, 0, { stdoutEmpty: true })]),
  ["model-assign wrong-type model", [...WRONG_TYPE_LABELS, "object holding a model name", "list holding a model name"], readFailure("model", 0, { stdoutEmpty: true })],
  ["model-assign wrong-type effort", WRONG_TYPE_LABELS, readFailure("effort", 0, { stdoutEmpty: true })],
  ["model-assign wrong-type resumeFromRunId", ["true", "object", "number", "list"], () => ({ code: 2, stderrIncludes: WORKFLOW_DENIED })],
  ["model-assign wrong-type scriptPath", TRUTHY_WRONG_TYPE_LABELS, () => ({ code: 2, stderrIncludes: WORKFLOW_DENIED })],
  ...["cwd", "trigger", "transcript_path"].map((field): Rule => [`handoff wrong-type ${field}`, TRUTHY_WRONG_TYPE_LABELS, () => ({ code: 0, stdoutIncludes: "handoff recorded: " })]),
  ["report-gate wrong-type stop_hook_active", NOT_TRUE_LABELS, () => ({ code: 0, stdoutIncludes: "changes outside the brief's scope" })],
  ["report-gate wrong-type state ev at handback", NOT_TRUE_LABELS, () => ({ code: 2, stderrIncludes: "report has no evidence token" })],
  ["report-gate wrong-type state hb at stop", NOT_TRUE_LABELS, () => ({ code: 0, stdoutIncludes: "report has no evidence token" })],
  ["report-gate wrong-type message", [...WRONG_TYPE_LABELS, "object holding evidence"], readFailure("message", 2, { stderrIncludes: REFUSED_REPORT })],
  ...[["agent_id", "agent_id at handback"], ["transcript_path", "transcript_path at handback"], ["session_id", "session_id at handback with a transcript"]]
    .map(([field, name]): Rule => [`report-gate wrong-type ${name}`, WRONG_TYPE_LABELS, readFailure(field ?? "", 2, { stderrIncludes: REFUSED_REPORT })]),
  ["report-gate wrong-type agent_transcript_path at stop", WRONG_TYPE_LABELS, readFailure("agent_transcript_path", 0, { stdoutIncludes: REFUSED_REPORT })],
  ...["tool name", "bash command", "file_path", "notebook_path"].map((name): Rule => [`transcript ${name}`, perPosition(WRONG_TYPE_LABELS), () => ({ code: 0, stdoutIncludes: REFUSED_REPORT })]),
  ["transcript role", perPosition(["number", "true", "list", "object", "zero", "false"]), () => ({ code: 0, stdoutIncludes: REFUSED_REPORT })],
];

export const WRONG_TYPE_DIVERGENCES: ReadonlyMap<string, TsOutcome> = new Map(RULES.flatMap(([family, labels, outcome]) =>
  labels.map((label): [string, TsOutcome] => [`${family} ${label}`, outcome(label)])));
