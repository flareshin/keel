import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, lstatSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { missDetail, missingFields, OUTCOME } from "../lib/hookkit/contract.ts";
import { dataDir, keelCli } from "../lib/hookkit/env.ts";
import { FireLog } from "../lib/hookkit/fires.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";
import { dumpsAscii } from "../lib/hookkit/jsonout.ts";
import { expandUser, joinPath, normalizePath } from "../lib/hookkit/paths.ts";
import { editTarget, FieldTypeError, getField, isRecord, textField, textOrEmpty } from "../lib/hookkit/fields.ts";
import { compareCodePoints, MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts";
import { NonFiniteJsonNumber, parseFiniteJson, parseJson, parsePayload } from "../lib/hookkit/json.ts";
import { AttributeError, describeError, errorName, pythonTypeName, RecursionError, ValueError } from "../lib/hookkit/errors.ts";
import { readStdin } from "../lib/hookkit/stdio.ts";
import { SPACE_CHARS, SPACE_CLASS, testCaseFolded, trimCharacters, trimSpace, WORD_BOUNDARY, WORD_CHARS } from "../lib/hookkit/text.ts";
import { OSError, run, TimeoutExpired } from "../lib/hookkit/subprocess.ts";
import type { CompletedProcess } from "../lib/hookkit/subprocess.ts";
import { commandWritesFiles } from "../lib/hookkit/shell.ts";
import { contentOf, iterEntries, roleOf, textOf, toolUses } from "../lib/hookkit/transcript.ts";

const HOOK = "report-gate";
const CLI_TIMEOUT_SECONDS = 20;
const DIGIT = "\\p{Nd}";

const EVIDENCE_RE = new RegExp(
  `Tests run:${SPACE_CLASS}*${DIGIT}` +
  `|${WORD_BOUNDARY}${DIGIT}+${SPACE_CLASS}+pass(?:ed|ing)${WORD_BOUNDARY}` +
  `|${WORD_BOUNDARY}${DIGIT}[${DIGIT},]*${SPACE_CLASS}+(?:[a-z]+${SPACE_CLASS}+)?(?:tests?|specs?|checks?|cases?|suites?)${SPACE_CLASS}+pass(?:ed|ing)${WORD_BOUNDARY}` +
  `|${WORD_BOUNDARY}${DIGIT}+${SPACE_CLASS}*/${SPACE_CLASS}*${DIGIT}+${SPACE_CLASS}+(?:tests?${SPACE_CLASS}+|checks?${SPACE_CLASS}+)?pass(?:ed|ing)${WORD_BOUNDARY}` +
  `|${WORD_BOUNDARY}Ran ${DIGIT}+ tests?${WORD_BOUNDARY}|#${SPACE_CLASS}*pass${SPACE_CLASS}+${DIGIT}` +
  `|exit(?:ed)?(?:${SPACE_CLASS}+(?:with${SPACE_CLASS}+)?(?:code|status))?[:= ]*0${WORD_BOUNDARY}|\\$\\?${SPACE_CLASS}*=?${SPACE_CLASS}*0` +
  `|grep${SPACE_CLASS}+-c|wc${SPACE_CLASS}+-[lc]|diff --git|files? changed|[${WORD_CHARS}./~-]+\\.[A-Za-z]{1,5}:${DIGIT}+` +
  `|UNVERIFIED${SPACE_CLASS}*:|NOT VERIFIED`,
  "iu",
);

export function hasEvidenceToken(report: string): boolean {
  return testCaseFolded(EVIDENCE_RE, report);
}

const VERDICT_RE = new RegExp(
  `${WORD_BOUNDARY}(?:PASS|BLOCK|ASK|READY_TO_MERGE|NEEDS_FIXES|SHIP_READY|BUGS_FOUND|BLOCKED|INVESTIGATE_FURTHER)${WORD_BOUNDARY}` +
  `|VERDICT${SPACE_CLASS}*:`,
  "u",
);
const REVIEW_VERDICTS: ReadonlyMap<string, string> = new Map([["VERDICT: PASS", "PASS"], ["VERDICT: NEEDS_FIXES", "NEEDS_FIXES"]]);
const KEEL_EVIDENCE_RE = new RegExp(`(?<![^\\n])${SPACE_CLASS}*KEEL-EVIDENCE: (\\{[^\\n]*\\})${SPACE_CLASS}*(?=\\n|$)`, "gu");
export const REPORT_START = "<<<KEEL-REPORT";
export const REPORT_END = "KEEL-REPORT>>>";
const SCOPE_RE = /\[SCOPE\][ \t]*([^\n]+)/g;
const SCOPE_SEPARATOR_RE = new RegExp(`[,${SPACE_CHARS}]+`);
const SCOPE_EXEMPT_PREFIXES: readonly string[] = ["/tmp/", "/private/tmp/", "/var/folders/"];
const SCRATCH_PREFIXES: readonly string[] = [...SCOPE_EXEMPT_PREFIXES, ...(process.env["TMPDIR"] ? [process.env["TMPDIR"]] : [])];
const PATH_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "notebookedit", "multiedit"]);
const EVIDENCE_MARKER = "[EVIDENCE]";
const NO_TRANSCRIPT = "review evidence skipped: no subagent transcript";
const STATE_NAME_UNSAFE = new RegExp(`[^${WORD_CHARS}.-]`, "gu");

const EVIDENCE_TEXT =
  "This report is under the evidence contract (the brief carries an [EVIDENCE] marker, the agent " +
  "changed files, or the report claims a verdict) and holds no evidence token. Re-emit the full " +
  "report citing an actual output line from a check you ran: a test-runner summary with its count, " +
  "the command's zero exit status, a grep or wc count, a file path with line number, or a diff " +
  "summary. If you did not verify, say so in one line starting 'UNVERIFIED:' with the reason.";
const UNCHECKABLE_TEXT =
  `Reading the hook input, the turn state or the agent transcript held JSON the gate does not follow (nesting deeper than ${MAX_JSON_DEPTH} levels, ` +
  "or a NaN or Infinity number in an agent transcript line), " +
  "so it cannot tell whether the report is proven or the changes are in scope.";
const UNREADABLE_TEXT =
  "The hook input or the agent transcript holds a field of the wrong type (an id, a path, the report text or a tool call that is not text), " +
  "so the gate cannot tell whether the report is proven or the changes are in scope.";
const UNPARSED_EVENT = /"hook_event_name"\s*:\s*"(PreToolUse|SubagentStop)"/;
const UNPARSED_HANDBACK_TOOL = /"tool_name"\s*:\s*"subagenthandback"/i;
const UNPARSED_STOP_RETRY = /"stop_hook_active"\s*:\s*true/;
export const HANDBACK_TAIL = "Then hand back the corrected full report (SubagentHandback or your final message).";

class TurnState {
  readonly path: string | null;
  flaggedPaths: string[] = [];
  evidenceDenied = false;
  handedBack = false;

  constructor(payload: Payload) {
    const sessionId = textField(payload, "session_id");
    const agentId = textField(payload, "agent_id");
    const name = `${sessionId}-${agentId}`.replace(STATE_NAME_UNSAFE, "_") + ".json";
    this.path = sessionId !== "" && agentId !== "" ? joinPath(dataDir(), "state", "keel", "report-gate", name) : null;
    if (this.path === null || !existsSync(this.path)) return;
    let data: unknown;
    try {
      data = parseJson(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (!isReadFailure(error)) throw error;
      this.handedBack = true;
      return;
    }
    if (!isRecord(data)) throw new AttributeError(`'${pythonTypeName(data)}' object has no attribute 'get'`);
    this.flaggedPaths = flaggedPathsOf(getField(data, "paths"));
    this.evidenceDenied = getField(data, "ev") === true;
    this.handedBack = getField(data, "hb") === true;
  }

  save(): void {
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const state = { paths: this.flaggedPaths, ev: this.evidenceDenied, hb: this.handedBack };
    writeFileSync(this.path, dumpsAscii(state), "utf8");
  }
}

function flaggedPathsOf(stored: unknown): string[] {
  if (Array.isArray(stored)) return stored as string[];
  return isRecord(stored) ? Object.keys(stored) : [];
}

function isReadFailure(error: unknown): boolean {
  return error instanceof ValueError || typeof (error as NodeJS.ErrnoException).code === "string";
}

class AgentTranscript {
  scopes: string[] = [];
  outOfScope: string[] = [];
  needsEvidence = false;
  editedFiles = false;
  usedStructuredOutput = false;
  finalText: string | null = null;

  constructor(path: string | null) {
    let briefSeen = false;
    for (const entry of path ? iterEntries(path) : []) {
      const role = roleOf(entry);
      if (role === "user" && !briefSeen) {
        briefSeen = true;
        this.readBrief(textOf(contentOf(entry)) ?? "");
      }
      if (role === "assistant") {
        const blocks = toolUses(entry);
        for (const block of blocks) {
          this.readToolUse(textOrEmpty(getField(block, "name"), "tool name").toLowerCase(), getField(block, "input"));
        }
        if (blocks.length > 0) this.finalText = null;
        else this.appendFinalText(textOf(contentOf(entry)));
      }
    }
  }

  private appendFinalText(text: string | null): void {
    if (text === null || trimSpace(text) === "") return;
    this.finalText = this.finalText === null ? text : `${this.finalText}\n${text}`;
  }

  private readBrief(brief: string): void {
    if (brief.includes(EVIDENCE_MARKER)) this.needsEvidence = true;
    for (const match of brief.matchAll(SCOPE_RE)) {
      for (const raw of (match[1] ?? "").split(SCOPE_SEPARATOR_RE)) {
        const token = trimCharacters(raw, "`'\"<>;");
        if (token.startsWith("/") || token.startsWith("~")) this.scopes.push(normalize(token));
      }
    }
  }

  private readToolUse(name: string, input: unknown): void {
    const toolArgs: Payload = isRecord(input) ? input : {};
    if (name === "structuredoutput") this.usedStructuredOutput = true;
    const command = name === "bash" ? textField(toolArgs, "command") : "";
    const edits = PATH_EDIT_TOOLS.has(name);
    if (edits || commandWritesFiles(command)) this.needsEvidence = true;
    if (edits || commandWritesFiles(command, SCRATCH_PREFIXES)) this.editedFiles = true;
    const target = edits ? editedPath(toolArgs) : "";
    if (target !== "" && this.scopes.length > 0 && !inScope(target, this.scopes)
        && !this.outOfScope.includes(normalize(target))) {
      this.outOfScope.push(normalize(target));
    }
  }
}

function readAgentTranscript(path: string | null): AgentTranscript {
  try {
    return new AgentTranscript(path);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (path !== null && typeof failure.code === "string" && failure.path === undefined) failure.path = path;
    throw failure;
  }
}

function editedPath(toolArgs: Payload): string {
  const { path, unreadable } = editTarget(toolArgs);
  if (unreadable !== null) throw unreadable;
  return path;
}

function main(): number {
  const raw = readStdin();
  let payload: Payload;
  try {
    payload = parsePayload(raw);
  } catch (error) {
    if (error instanceof RecursionError) return refuseUnparsedPayload(raw, error);
    if (!(error instanceof ValueError)) throw error;
    new FireLog(HOOK, null).append("K2", "error", { detail: `payload is not JSON: ${error.message}` });
    return protocol.EXIT_PASS;
  }
  const fires = new FireLog(HOOK, getField(payload, "session_id") as string | null);
  try {
    const event = getField(payload, "hook_event_name");
    if (event === "PreToolUse") return judgeHandback(payload, fires);
    if (event === "SubagentStop") return judgeStop(payload, fires);
    return protocol.EXIT_PASS;
  } catch (error) {
    if (error instanceof UncheckableReport) return refuseUncheckable(payload, error, fires);
    if (error instanceof FieldTypeError) return refuseUnreadable(payload, error, fires);
    fires.append("K2", "error", { detail: describeError(error) });
    return protocol.EXIT_PASS;
  }
}

function judgeHandback(payload: Payload, fires: FireLog): number {
  if (protocol.toolName(payload) !== "subagenthandback") return protocol.EXIT_PASS;
  const missing = missingFields(payload, "tool_input.message", "agent_id");
  if (missing.length > 0) {
    fires.append("K2", OUTCOME, { detail: missDetail(payload, missing) });
    return protocol.EXIT_PASS;
  }
  const report = withoutReportMarkers(textField(protocol.toolInput(payload), "message")) ?? "";
  const state = whileDeciding(() => new TurnState(payload));
  state.handedBack = true;
  state.save();
  const agentTranscript = findHandbackTranscript(payload);
  if (agentTranscript === null) {
    fires.append("K2", OUTCOME, { detail: missDetail(payload, ["agent_transcript_path (derived)"]) });
  }
  const transcript = whileDeciding(() => readAgentTranscript(agentTranscript));

  const fresh = flagScopeViolations(transcript, state, fires);
  if (fresh.length > 0) return protocol.deny(scopeMessage(fresh));
  if (!state.evidenceDenied && lacksEvidence(report, transcript.needsEvidence, fires)) {
    state.evidenceDenied = true;
    state.save();
    return protocol.deny(evidenceMessage());
  }
  writeReviewEvidence(report, payload, agentTranscript, transcript, "SubagentHandback", fires);
  return protocol.EXIT_PASS;
}

function judgeStop(payload: Payload, fires: FireLog): number {
  const state = whileDeciding(() => new TurnState(payload));
  const handedBack = state.handedBack;
  if (state.evidenceDenied) {
    state.evidenceDenied = false;
    state.save();
  }
  if (isRetry(payload)) return protocol.EXIT_PASS;
  if (handedBack) {
    state.handedBack = false;
    state.save();
  }
  const missing = missingFields(payload, "agent_id", "agent_transcript_path", "last_assistant_message");
  const agentTranscript = textField(payload, "agent_transcript_path");
  const transcript = agentTranscript && existsSync(agentTranscript) ? whileDeciding(() => readAgentTranscript(agentTranscript)) : null;
  const payloadReport = missing.includes("last_assistant_message") ? null : textOf(getField(payload, "last_assistant_message"));
  const report = withoutReportMarkers(payloadReport ?? transcript?.finalText ?? null);
  const reportedElsewhere = handedBack || transcript?.usedStructuredOutput === true;
  const unrecovered = report !== null || reportedElsewhere ? missing.filter((field) => field !== "last_assistant_message") : missing;
  if (unrecovered.length > 0) fires.append("K2", OUTCOME, { detail: missDetail(payload, unrecovered) });
  if (transcript === null) {
    if (report && verdictOf(report) && hasEvidenceLine(report)) fires.append("K1", "warn", { detail: NO_TRANSCRIPT });
    return protocol.EXIT_PASS;
  }

  const fresh = flagScopeViolations(transcript, state, fires);
  if (fresh.length > 0) return protocol.blockStop(scopeMessage(fresh));
  if (reportedElsewhere) return protocol.EXIT_PASS;
  if (!report || trimSpace(report) === "") {
    if (transcript.needsEvidence) fires.append("K2", "warn", { detail: "no final text to judge" });
    return protocol.EXIT_PASS;
  }
  if (lacksEvidence(report, transcript.needsEvidence, fires)) return protocol.blockStop(evidenceMessage());
  writeReviewEvidence(report, payload, agentTranscript, transcript, "SubagentStop", fires);
  return protocol.EXIT_PASS;
}

class UncheckableReport extends Error {
  readonly reason: RecursionError | NonFiniteJsonNumber;

  constructor(reason: RecursionError | NonFiniteJsonNumber) {
    super(reason.message);
    this.reason = reason;
  }
}

function whileDeciding<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RecursionError || error instanceof NonFiniteJsonNumber) throw new UncheckableReport(error);
    throw error;
  }
}

function refuseUnparsedPayload(raw: string, error: RecursionError): number {
  new FireLog(HOOK, null).append("K2", "error", { detail: describeError(error) });
  const event = UNPARSED_EVENT.exec(raw)?.[1];
  if (event === "PreToolUse" && UNPARSED_HANDBACK_TOOL.test(raw)) return refuseHandback();
  if (event === "SubagentStop") return refuseStop(UNPARSED_STOP_RETRY.test(raw));
  return protocol.EXIT_PASS;
}

function refuseUncheckable(payload: Payload, error: UncheckableReport, fires: FireLog): number {
  fires.append("K2", "error", { detail: describeError(error.reason) });
  if (getField(payload, "hook_event_name") === "PreToolUse") return refuseHandback();
  return refuseStop(isRetry(payload));
}

function refuseUnreadable(payload: Payload, error: FieldTypeError, fires: FireLog): number {
  fires.append("K2", "error", { detail: describeError(error) });
  const message = protocol.formatMessage(HOOK, "could not read this report; refusing it", [["K2", UNREADABLE_TEXT]]);
  if (getField(payload, "hook_event_name") === "PreToolUse") return protocol.deny(message);
  return isRetry(payload) ? protocol.EXIT_PASS : protocol.blockStop(message);
}

function isRetry(payload: Payload): boolean {
  return getField(payload, "stop_hook_active") === true;
}

function refuseHandback(): number {
  return protocol.deny(refusalMessage());
}

function refuseStop(stopHookActive: boolean): number {
  return stopHookActive ? protocol.EXIT_PASS : protocol.blockStop(refusalMessage());
}

function refusalMessage(): string {
  return protocol.formatMessage(HOOK, "could not check this report; refusing it", [["K2", UNCHECKABLE_TEXT]]);
}

function findHandbackTranscript(payload: Payload): string | null {
  const mainPath = textField(payload, "transcript_path");
  const sessionId = textField(payload, "session_id");
  const agentId = textField(payload, "agent_id");
  if (mainPath === "" || sessionId === "" || agentId === "") return null;
  const base = joinPath(dirname(expandUser(mainPath)), sessionId, "subagents");
  const found = filesNamedUnder(base, `agent-${agentId}.jsonl`);
  return found.toSorted(compareCodePoints)[0] ?? null;
}

function filesNamedUnder(directory: string, fileName: string): string[] {
  const found: string[] = [];
  const candidate = joinPath(directory, fileName);
  if (lexists(candidate)) found.push(candidate);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return found;
  }
  for (const name of names) {
    const child = joinPath(directory, name);
    if (!name.startsWith(".") && isDirectoryEntry(child)) found.push(...filesNamedUnder(child, fileName));
  }
  return found;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectoryEntry(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeReviewEvidence(
  report: string, payload: Payload, agentTranscript: string | null, transcript: AgentTranscript, via: string, fires: FireLog,
): void {
  const verdict = verdictOf(report);
  const evidenceLines = Array.from(report.matchAll(KEEL_EVIDENCE_RE), (match) => match[1] ?? "");
  if (verdict === null || evidenceLines.length === 0) return;
  if (!protocol.isSubagent(payload) || !agentTranscript) {
    fires.append("K1", "warn", { detail: NO_TRANSCRIPT });
    return;
  }
  if (transcript.editedFiles) {
    fires.append("K1", "warn", {
      detail: "reviewer-mutated: review evidence refused, the reviewer edited files (an author never judges its own output)",
    });
    return;
  }
  const source: Record<string, unknown> = {};
  for (const key of ["session_id", "agent_id", "agent_type", "transcript_path"]) source[key] = getField(payload, key);
  source["agent_transcript_path"] = agentTranscript;
  source["via"] = via;
  for (const line of evidenceLines) sendToCli(line, verdict, source, fires);
}

function sendToCli(evidenceLine: string, verdict: string, source: Record<string, unknown>, fires: FireLog): void {
  let request: string;
  try {
    request = dumpsAscii({ keel_evidence: parseFiniteJson(evidenceLine), verdict, source });
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    fires.append("K1", "warn", { detail: "KEEL-EVIDENCE line is not JSON" });
    return;
  }
  let result: CompletedProcess;
  try {
    result = run([keelCli(), "evidence", "write-review"], CLI_TIMEOUT_SECONDS, { input: request });
  } catch (error) {
    if (!(error instanceof OSError || error instanceof TimeoutExpired)) throw error;
    fires.append("K1", "warn", { detail: `keel evidence write-review did not run: ${errorName(error)}` });
    return;
  }
  if (result.returncode !== 0) {
    fires.append("K1", "warn", { detail: `write-review exit ${result.returncode}: ${trimSpace(result.stderr)}` });
    return;
  }
  fires.append("K1", "record", { detail: `review evidence ${evidenceIdOf(result.stdout)}` });
}

function evidenceIdOf(stdout: string): string {
  try {
    const response = parseJson(stdout);
    const evidenceId = isRecord(response) ? getField(response, "evidence_id") : null;
    return typeof evidenceId === "string" ? evidenceId : "(unparsed stdout)";
  } catch (error) {
    if (error instanceof ValueError) return "(unparsed stdout)";
    throw error;
  }
}

export function withoutReportMarkers(report: string | null): string | null {
  if (!report) return report;
  const lines = comparableLines(report);
  const start = trimSpace(lines[0] ?? "") === REPORT_START ? 1 : 0;
  const end = lines.length > start && trimSpace(lines[lines.length - 1] ?? "") === REPORT_END ? lines.length - 1 : lines.length;
  return lines.slice(start, end).join("\n");
}

function comparableLines(text: string): string[] {
  const trimmedLines = text.split("\n").map((line) => line.replace(new RegExp(`${SPACE_CLASS}+$`), ""));
  return trimCharacters(trimmedLines.join("\n"), "\n").split("\n");
}

function verdictOf(report: string): string | null {
  const firstLine = report.replace(new RegExp(`^${SPACE_CLASS}+`), "").split("\n")[0] ?? "";
  return REVIEW_VERDICTS.get(firstLine.replace(new RegExp(`${SPACE_CLASS}+$`), "")) ?? null;
}

function hasEvidenceLine(report: string): boolean {
  return Array.from(report.matchAll(KEEL_EVIDENCE_RE)).length > 0;
}

function lacksEvidence(report: string, needsEvidence: boolean, fires: FireLog): boolean {
  const stripped = trimSpace(report);
  const exempt = !(needsEvidence || VERDICT_RE.test(stripped)) || stripped.startsWith("{") || stripped.startsWith("[");
  if (exempt) return false;
  const hasToken = hasEvidenceToken(stripped);
  if (hasToken) fires.append("K2", "pass");
  else fires.append("K2", "deny", { detail: evidenceDenyDetail(stripped) });
  return !hasToken;
}

function evidenceDenyDetail(report: string): string {
  const verdict = report.match(VERDICT_RE)?.[0];
  const requiredBy = verdict ? `its verdict "${verdict}"` : `its file writes or ${EVIDENCE_MARKER} brief`;
  return `no evidence token in a ${report.length}-char report; required by ${requiredBy}`;
}

function flagScopeViolations(transcript: AgentTranscript, state: TurnState, fires: FireLog): string[] {
  const fresh = transcript.outOfScope.filter((path) => !state.flaggedPaths.includes(path));
  if (fresh.length > 0) {
    state.flaggedPaths = [...new Set([...state.flaggedPaths, ...fresh])].sort(compareCodePoints);
    state.save();
    fires.append("K5", "deny", { detail: `${fresh.length} path(s) outside [SCOPE]` });
  }
  return fresh;
}

function scopeMessage(paths: string[]): string {
  const text =
    `The brief's [SCOPE] does not cover files you changed: ${protocol.listed(paths)}. Revert them. If one was genuinely ` +
    "needed, keep it reverted and name it with the reason in your report; widening the scope is the " +
    "caller's decision.";
  return protocol.formatMessage(HOOK, "changes outside the brief's scope", [["K5", text]], HANDBACK_TAIL);
}

export function evidenceMessage(): string {
  return protocol.formatMessage(HOOK, "report has no evidence token", [["K2", EVIDENCE_TEXT]], HANDBACK_TAIL);
}

function normalize(path: string): string {
  return normalizePath(expandUser(trimCharacters(trimSpace(path), "'\"")));
}

function inScope(path: string, scopes: readonly string[]): boolean {
  const target = normalize(path);
  return SCOPE_EXEMPT_PREFIXES.some((prefix) => target.startsWith(prefix)) || scopes.some(
    (scope) => target === scope || target.startsWith(scope.replace(/\/+$/, "") + "/"));
}

if (import.meta.main) process.exitCode = main();
