import { closeSync, existsSync, mkdirSync, openSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname as pathDirname } from "node:path";
import * as contract from "../lib/hookkit/contract.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";
import {
  arraysEqual, basename, getField, joinPath, lstripChar, normalizePath, partition, PY_WORD, pythonStr, truncate,
} from "../lib/hookkit/pycompat.ts";
import { isFile, shlexQuote } from "../lib/hookkit/pypath.ts";
import { AttributeError, pythonTypeName as pythonValueTypeName, readStdin, writeStderr } from "../lib/hookkit/pyruntime.ts";
import * as shell from "../lib/hookkit/shell.ts";
import type { Step } from "../lib/hookkit/shell.ts";
import { appendLogLine, iso, stateDir, utcNow } from "../../lib/evidence/env.ts";
import * as gc from "../../lib/evidence/gc.ts";
import * as gitcmd from "../../lib/evidence/gitcmd.ts";
import {
  decodeStrict, errorText, isJsonObject, JSONDecodeError, PyFloat, pyRepr, pyStr, pythonJsonLoads, pythonTypeName as errorTypeName, pyStrip,
  pyTruthy, sortedStrings, universalNewlines,
} from "../../lib/evidence/pycompat.ts";
import type { JsonValue } from "../../lib/evidence/pycompat.ts";
import * as registry from "../../lib/evidence/registry.ts";
import type { GatedRepo } from "../../lib/evidence/registry.ts";
import { runCaptured } from "../../lib/evidence/subprocess.ts";
import * as verify from "../../lib/evidence/verify.ts";
import type { Decision, Reason } from "../../lib/evidence/verify.ts";

const HOOK = "ship-gate";
const FIRES_DETAIL_LIMIT = 200;
const F_IRREVERSIBLE = "F-irreversible";
const WORD = `[${PY_WORD}]`;
const WORD_BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const DECISION_HINT = new RegExp(`${WORD_BOUNDARY}(git|gh|push|merge)${WORD_BOUNDARY}`, "u");
const PUSH_OR_MERGE_WORD = new RegExp(`${WORD_BOUNDARY}(push|merge)${WORD_BOUNDARY}`, "u");
const PUSH_OR_MERGE_WORDS: ReadonlySet<string> = new Set(["push", "merge"]);
const PUSH_OR_MERGE_WITHOUT_THE_WORD = new RegExp(
  `${WORD_BOUNDARY}send-pack${WORD_BOUNDARY}|(?<![${PY_WORD}.-])merges(?![${PY_WORD}.-])|(?<![${PY_WORD}.])git/refs${WORD_BOUNDARY}`,
  "u",
);
const PUSHES_OUTSIDE_GIT_PUSH: ReadonlySet<string> = new Set(["send-pack", "http-push"]);
const QUOTING = /['"\\]/g;
const PULL_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\p{Nd}+/u;
const PULL_MERGE_ENDPOINT = /\/pulls\/[^/]+\/merge\/?(?=\n?$)/u;
const BRANCH_MERGE_ENDPOINT = /\/merges\/?(?:\?|(?=\n?$))/u;
const REF_ENDPOINT = /(?:^|\/)git\/refs(?:\/|\?|(?=\n?$))/u;
const GRAPHQL_BRANCH_CHANGE = new RegExp(
  `${WORD_BOUNDARY}(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge|createRef|updateRefs?|deleteRef)${WORD_BOUNDARY}`,
  "u",
);
const GH_API_METHOD_OPTIONS: ReadonlySet<string> = new Set(["-X", "--method"]);
const GH_API_FIELD_OPTIONS: readonly string[] = ["-f", "-F", "--field", "--raw-field"];
const GH_API_BODY_OPTIONS: readonly string[] = [...GH_API_FIELD_OPTIONS, "--input"];
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const GH_API_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  ...GH_API_METHOD_OPTIONS, ...GH_API_BODY_OPTIONS, "-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview",
  "--cache",
]);
const URL_FORM = /^[^/]*:/u;
const PROGRAMS_THAT_MAY_PUSH: ReadonlySet<string> = new Set(["git", "gh", ...shell.SHELLS]);
export const ARGV_FORWARDERS: ReadonlySet<string> = new Set([
  "xargs", "parallel", "env", "sudo", "exec", "nice", "nohup", "time", "timeout", "gtimeout", "command",
]);
const PR_VIEW_FIELDS = "statusCheckRollup,baseRefName";
const FAILED_CHECKS: ReadonlySet<string> = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const PENDING_CHECKS: ReadonlySet<string> = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]);
export const GH_TIMEOUT_SECONDS = 12;
const GC_INTERVAL_SECONDS = 24 * 3600;
const MERGE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-A", "--author-email", "-b", "--body", "-F", "--body-file", "-t", "--subject"]);
const REPOINTING_OPTIONS: ReadonlySet<string> = new Set(["--git-dir", "--work-tree"]);
const REPOINTING_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE"];
const CONFIG_OVERRIDE_OPTIONS: ReadonlySet<string> = new Set(["-c", "--config-env"]);
const GH_DEFAULT_VIEW_OPTIONS: ReadonlySet<string> = new Set(["-v", "--view"]);
const PUSH_ROUTING_SECTIONS: ReadonlySet<string> = new Set(["remote", "branch", "url", "push", "include", "includeif"]);
const CONFIG_VARIABLE_PREFIX = "GIT_CONFIG";
const REMOTE_EDITS: ReadonlySet<string> = new Set(["set-url", "add", "rename"]);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const TAG_PREFIX = "refs/tags/";
const HEAD = "HEAD";
const K1 = verify.K1;
const RISK = verify.RISK;

export class GateError extends Error {}

export class UnclearTarget extends Error {
  readonly addedWords: string[];

  constructor(why: string, addedWords: readonly string[] = []) {
    super(why);
    this.addedWords = [...addedWords];
  }
}

export interface Refspec {
  source: string;
  destination: string | null;
}

export interface Push {
  kind: "push";
  workdir: string;
  words: string[];
  remote: string | null;
  refspecs: Refspec[];
  deletesOnly: boolean;
  tagsOnly: boolean;
  wholeRepo: boolean;
  dryRun: boolean;
}

export interface Merge {
  kind: "merge";
  workdir: string;
  words: string[];
  selector: string | null;
  repoFlag: string | null;
  repoEnv: string | null;
  auto: boolean;
  matchHead: string | null;
}

export interface Unattributable {
  kind: "unattributable";
  workdir: string;
  words: string[];
  why: string;
  userCommand: string | null;
}

export interface PrCreate {
  kind: "prCreate";
  workdir: string;
  words: string[];
}

export type Action = Push | Merge | Unattributable | PrCreate;
type Environment = Map<string, string>;
type Where = Record<string, unknown>;
type Target = [repoRoot: string, repoKey: string | null, row: GatedRepo | null];

export function pushSources(push: Push): string[] {
  return push.refspecs.map((spec) => spec.source);
}

class Report {
  readonly session: unknown;
  readonly event: unknown;
  readonly blocks: string[] = [];
  readonly context: string[] = [];

  constructor(payload: Payload, event: unknown) {
    const session = getField(payload, "session_id");
    this.session = pyTruthy(session) ? session : "-";
    this.event = event;
  }

  deny(reasons: readonly Reason[], summary: string, hint: string, where: Where = {}): void {
    this.logEach(reasons, "deny", where);
    this.blocks.push(message(summary, reasons, hint));
  }

  warn(reasons: readonly Reason[], summary: string, where: Where = {}): void {
    this.logEach(reasons, "warn", where);
    this.context.push(message(summary, reasons));
  }

  passed(repo: string | null, where: Where = {}): void {
    this.fire(RISK, "pass", { repo, ...where });
  }

  record(detail: string, where: Where = {}): void {
    this.fire(K1, "record", { detail, ...where });
  }

  decide(decision: Decision, summary: string, hint: string, repo: string, head: string): void {
    const where = { head, risk: decision.riskClass, root_run_id: decision.rootRunId, files: decision.files, lines: decision.lines };
    if (decision.ok) {
      this.passed(repo, { detail: decision.k3Waiver ? "K3 waived: " + decision.k3Waiver : null, ...where });
      return;
    }
    this.deny(decision.reasons, `${summary} (risk ${decision.riskClass || "none"})`, hint, { repo, ...where });
  }

  contractMiss(missing: string[], payload: Payload): void {
    this.fire(K1, contract.OUTCOME, { detail: contract.missDetail(payload, missing) });
  }

  error(error: unknown, failClosed: boolean, hint: string, repo: string | null = null): void {
    const detail = errorLabel(error);
    if (failClosed) {
      this.blocks.push(message("internal error; failing closed for a gated repo", [{ ruleId: K1, text: detail }], hint));
    }
    this.fire(K1, "error", { repo, detail });
  }

  emit(): number {
    if (this.blocks.length > 0) return protocol.deny(backslashReplaced(this.blocks.join("\n\n")));
    if (this.context.length > 0) return protocol.warn(valueText(this.event), this.context.join("\n"));
    return protocol.EXIT_PASS;
  }

  private logEach(reasons: readonly Reason[], outcome: string, where: Where): void {
    const firstText = new Map<string, string>();
    for (const reason of reasons) if (!firstText.has(reason.ruleId)) firstText.set(reason.ruleId, reason.text);
    for (const [ruleId, text] of firstText) this.fire(ruleId, outcome, { detail: text, ...where });
  }

  private fire(ruleId: string, outcome: string, where: Where): void {
    const line: Record<string, unknown> = { ts: iso(utcNow()), rule_id: ruleId, hook: HOOK, outcome, session: this.session };
    for (const [key, value] of Object.entries(where)) {
      if (value !== null && value !== undefined && value !== "") line[key] = value;
    }
    if (typeof line["detail"] === "string") line["detail"] = truncate(line["detail"], FIRES_DETAIL_LIMIT);
    appendLogLine("keel-fires.jsonl", line as Record<string, JsonValue>);
  }
}

function backslashReplaced(text: string): string {
  return text.replace(LONE_SURROGATE, (surrogate) => "\\u" + surrogate.charCodeAt(0).toString(16).padStart(4, "0"));
}

function isScalarNumber(value: unknown): value is PyFloat | bigint {
  return value instanceof PyFloat || typeof value === "bigint";
}

function valueText(value: unknown): string {
  return isScalarNumber(value) ? pyStr(value) : pythonStr(value);
}

function valueTypeName(value: unknown): string {
  if (value instanceof PyFloat) return "float";
  return typeof value === "bigint" ? "int" : pythonValueTypeName(value);
}

function errorLabel(error: unknown): string {
  return `${errorTypeName(error)}: ${errorText(error)}`;
}

function main(): number {
  const raw = readStdin();
  try {
    return dispatch(pythonJsonLoads(raw));
  } catch (error) {
    return failClosed(raw, error);
  }
}

function dispatch(payload: unknown): number {
  if (!isJsonObject(payload)) {
    throw new AttributeError(`'${valueTypeName(payload)}' object has no attribute 'get'`);
  }
  const eventField = getField(payload, "hook_event_name");
  const event = pyTruthy(eventField) ? eventField : "";
  const report = new Report(payload, event);
  if (event === "PreToolUse" && getField(payload, "tool_name") === "Bash") guardBash(payload, report);
  return report.emit();
}

function failClosed(raw: string, error: unknown): number {
  const detail = errorLabel(error);
  const command = bashCommandOf(raw);
  if (!mayPushOrMerge(command)) {
    writeStderr(backslashReplaced(`ship-gate: internal error on a command that is not a push or merge: ${detail}\n`));
    return protocol.EXIT_PASS;
  }
  return protocol.deny(backslashReplaced(message("internal error; failing closed", [{ ruleId: K1, text: detail }], command)));
}

function bashCommandOf(raw: string): string {
  let payload: unknown;
  try {
    payload = pythonJsonLoads(raw);
  } catch (error) {
    if (error instanceof JSONDecodeError) return raw;
    throw error;
  }
  if (!isJsonObject(payload)) return "";
  if (getField(payload, "hook_event_name") !== "PreToolUse" || getField(payload, "tool_name") !== "Bash") return "";
  return commandOf(payload);
}

function commandOf(payload: Payload): string {
  const command = getField(protocol.toolInput(payload), "command");
  return valueText(pyTruthy(command) ? command : "");
}

function guardBash(payload: Payload, report: Report): void {
  const missing = contract.missingFields(payload, "tool_input.command");
  if (missing.length > 0) report.contractMiss(missing, payload);
  const command = commandOf(payload);
  if (!DECISION_HINT.test(command)) return;
  const cwdField = getField(payload, "cwd");
  const cwd = pyTruthy(cwdField) ? cwdField : process.cwd();
  if (typeof cwd !== "string") throw new TypeError(`expected string object, got '${valueTypeName(cwd)}'`);
  const actions = callActions(command, cwd);
  for (const action of actions) judgeAction(action, report);
  if (actions.some((action) => action.kind === "push" || action.kind === "merge")) collectGarbageIfDue(report);
}

export function mayPushOrMerge(call: string): boolean {
  const unquoted = unquote(call);
  const runtimeGitOrGh = DECISION_HINT.test(unquoted) && shell.RUN_TIME_WORD_RE.test(unquoted);
  return spellsPushOrMerge(call) || runtimeGitOrGh;
}

function spellsPushOrMerge(call: string): boolean {
  const unquoted = unquote(call);
  return PUSH_OR_MERGE_WORD.test(unquoted) || PUSH_OR_MERGE_WITHOUT_THE_WORD.test(unquoted) || GRAPHQL_BRANCH_CHANGE.test(call);
}

function unquote(command: string): string {
  return command.replace(QUOTING, "");
}

export function callActions(call: string, cwd: string): Action[] {
  const actions: Action[] = [];
  const unattributable = new Set<shell.SimpleCommand>();
  for (const step of shell.steps(call, cwd)) {
    if (runsUnder(step.command, unattributable)) continue;
    const stepActions = actionsOf(step, call, cwd);
    if (stepActions.some((action) => action.kind === "unattributable")) unattributable.add(step.command);
    actions.push(...stepActions);
  }
  return actions;
}

function runsUnder(command: shell.SimpleCommand, runners: ReadonlySet<shell.SimpleCommand>): boolean {
  for (let parent = command.parent; parent !== null; parent = parent.parent) {
    if (runners.has(parent)) return true;
  }
  return false;
}

export function actionsOf(step: Step, call: string = "", callCwd: string = ""): Action[] {
  const words = step.argv;
  const workdir = step.directory;
  const first = words[0];
  if (first === undefined) return [];
  if (hidesPushOrMerge(step, call)) {
    return [resolvedAtRunTime(workdir, words, `\`${basename(step.command.argv[0] ?? "")}\` wraps it`, call, callCwd)];
  }
  const program = basename(first);
  if (program === "git") return gitActions(step, call, callCwd);
  if (program === "gh") return ghActions(shell.ghSubcommandArgv(words), workdir, step.environment, call, callCwd);
  if (shell.RUN_TIME_WORD_RE.test(first) && runtimeNameMayPushOrMerge(words, call)) {
    return [resolvedAtRunTime(workdir, words, `\`${first}\` is resolved only at run time`, call, callCwd)];
  }
  return [];
}

function ghActions(words: string[], workdir: string, environment: Environment, call: string, callCwd: string): Action[] {
  if (arraysEqual(words.slice(1, 3), ["pr", "merge"])) {
    const merge = parseMerge(words, workdir, environment.get("GH_REPO") ?? null);
    const namesRepo = repoNamingSources(merge).some(([, name]) => name);
    const redirected = namesRepo ? null : ghDefaultChangeIn(call, callCwd);
    if (redirected) {
      return [resolvedAtRunTime(workdir, words, `\`${redirected}\` changes the repo gh merges in`, call, callCwd)];
    }
    return [merge];
  }
  if (arraysEqual(words.slice(1, 3), ["pr", "create"])) return [{ kind: "prCreate", workdir, words }];
  const isApi = arraysEqual(words.slice(1, 2), ["api"]);
  if (isApi && ghApiChangesABranch(words.slice(2))) {
    return [unattributable(workdir, words, "`gh api` merges or moves a branch outside the gate")];
  }
  if (isApi && ghApiHidesItsTarget(words.slice(2))) {
    return [resolvedAtRunTime(workdir, words, "`gh api` writes to an endpoint resolved at run time", call, callCwd)];
  }
  return [];
}

function ghApiChangesABranch(args: string[]): boolean {
  const branchChanges = [PULL_MERGE_ENDPOINT, BRANCH_MERGE_ENDPOINT, GRAPHQL_BRANCH_CHANGE];
  if (args.some((arg) => branchChanges.some((pattern) => pattern.test(arg)))) return true;
  return args.some((arg) => REF_ENDPOINT.test(arg)) && ghApiWrites(args);
}

function ghApiHidesItsTarget(args: string[]): boolean {
  const [options, operands] = readGhApi(args);
  const fields = options.filter(([option]) => GH_API_FIELD_OPTIONS.includes(option)).map(([, value]) => partition(value, "="));
  const runTimeQuery = fields.some(([name, , value]) =>
    shell.RUN_TIME_WORD_RE.test(name) || (name === "query" && shell.RUN_TIME_WORD_RE.test(value)));
  const runTimeWord = [...operands, ...options.map(([option]) => option)].some((word) => shell.RUN_TIME_WORD_RE.test(word));
  return (runTimeQuery || runTimeWord) && ghApiWrites(args);
}

function ghApiWrites(args: string[]): boolean {
  const [options, operands] = readGhApi(args);
  if (options.some(([option]) => shell.RUN_TIME_WORD_RE.test(option))) return true;
  if (operands.length > 1 && operands.some((word) => shell.RUN_TIME_WORD_RE.test(word))) return true;
  const methods = options.filter(([option]) => GH_API_METHOD_OPTIONS.has(option)).map(([, value]) => value);
  const lastMethod = methods.at(-1);
  if (lastMethod !== undefined) return !READ_METHODS.has(lastMethod.toUpperCase());
  return options.some(([option]) => GH_API_BODY_OPTIONS.includes(option));
}

type GhApiOption = [option: string, value: string];

function readGhApi(args: string[]): [GhApiOption[], string[]] {
  const options: GhApiOption[] = [];
  const operands: string[] = [];
  const words = args.values();
  for (const word of words) {
    if (word.startsWith("--")) {
      const [option, separator, value] = partition(word, "=");
      const takesNext = !separator && GH_API_VALUE_OPTIONS.has(option);
      options.push([option, takesNext ? nextWord(words) : value]);
    } else if (word.startsWith("-")) {
      options.push(...readGhApiCluster(word.slice(1), words));
    } else {
      operands.push(word);
    }
  }
  return [options, operands];
}

function readGhApiCluster(letters: string, words: ArrayIterator<string>): GhApiOption[] {
  const options: GhApiOption[] = [];
  let rest = letters;
  while (rest) {
    const option = "-" + rest[0];
    rest = rest.slice(1);
    if (GH_API_VALUE_OPTIONS.has(option)) {
      options.push([option, rest.startsWith("=") ? rest.slice(1) : rest || nextWord(words)]);
      break;
    }
    options.push([option, ""]);
  }
  return options;
}

function nextWord(words: ArrayIterator<string>): string {
  const next = words.next();
  return next.done ? "" : next.value;
}

function runtimeNameMayPushOrMerge(words: string[], call: string): boolean {
  const ghApiWrite = arraysEqual(words.slice(1, 2), ["api"]) && ghApiWrites(words.slice(2));
  return spellsPushOrMerge(call) || words.slice(1).some((word) => PUSH_OR_MERGE_WORDS.has(word)) || ghApiWrite;
}

function hidesPushOrMerge(step: Step, call: string): boolean {
  const keptForwarder = ARGV_FORWARDERS.has(basename(step.argv[0] ?? "")) && step.argv[0] !== "command";
  if (!(keptForwarder || step.unattributableOptions.length > 0)) return false;
  const forwarded = step.command.argv.slice(1);
  const runsOpaque = forwarded.some((word) =>
    PROGRAMS_THAT_MAY_PUSH.has(basename(word)) || shell.dashedGitSubcommand(word) !== null || shell.RUN_TIME_WORD_RE.test(word));
  return runsOpaque && (spellsPushOrMerge(call) || forwarded.some((word) => PUSH_OR_MERGE_WORDS.has(word)));
}

function gitActions(step: Step, call: string, callCwd: string): Action[] {
  const index = shell.gitSubcommandIndex(step.argv);
  if (index === null) return [];
  const subcommand = step.argv[index] ?? "";
  const args = step.argv.slice(index + 1);
  const workdir = shell.gitDirectory(step.argv, step.directory, step.expansion);
  const words = [...withoutDirectoryOptions(step.argv.slice(0, index)), ...step.argv.slice(index)];
  if (shell.RUN_TIME_WORD_RE.test(subcommand)) {
    return [resolvedAtRunTime(workdir, words, `the git subcommand \`${subcommand}\` is resolved only at run time`, call, callCwd)];
  }
  if (PUSHES_OUTSIDE_GIT_PUSH.has(subcommand) || (subcommand === "subtree" && args.includes("push"))) {
    return [unattributable(workdir, words, `\`git ${subcommand}\` pushes outside the gate`)];
  }
  if (subcommand !== "push") return [];
  const repointed = repointing(step.argv.slice(1), step.environment);
  if (repointed) return [unattributable(workdir, words, `\`${repointed}\` points git at another repository`)];
  const reconfigured = configOverride(step.argv.slice(1, index), step.environment) || configChangeIn(call, callCwd);
  if (reconfigured) {
    return [resolvedAtRunTime(workdir, words, `\`${reconfigured}\` changes git config the gate reads from the clone`, call, callCwd)];
  }
  const push = parsePush(words, args, workdir);
  if (push.remote && shell.RUN_TIME_WORD_RE.test(push.remote)) {
    return [resolvedAtRunTime(workdir, words, `the push remote \`${push.remote}\` is resolved only at run time`, call, callCwd)];
  }
  return [push];
}

function unattributable(workdir: string, words: string[], why: string, userCommand: string | null = null): Unattributable {
  return { kind: "unattributable", workdir, words, why, userCommand };
}

function resolvedAtRunTime(workdir: string, words: string[], why: string, call: string, callCwd: string): Unattributable {
  const userCommand = call ? `cd ${shlexQuote(callCwd || workdir)} && ${call}` : null;
  return unattributable(workdir, words, why, userCommand);
}

function withoutDirectoryOptions(gitWords: string[]): string[] {
  const kept: string[] = [];
  const words = gitWords.values();
  for (const word of words) {
    if (word === "-C") words.next();
    else kept.push(word);
  }
  return kept;
}

function repointing(args: string[], environment: Environment): string | null {
  for (const word of args) {
    if (REPOINTING_OPTIONS.has(partition(word, "=")[0])) return word;
  }
  for (const name of REPOINTING_VARIABLES) {
    if (environment.has(name)) return `${name}=${environment.get(name)}`;
  }
  return null;
}

function configOverride(globalWords: string[], environment: Environment): string | null {
  const words = globalWords.values();
  for (const word of words) {
    const [option, , attached] = partition(word, "=");
    if (!CONFIG_OVERRIDE_OPTIONS.has(option)) continue;
    const setting = attached || nextWord(words);
    if (routesPushes(setting)) return `${option} ${setting}`;
  }
  const variable = [...environment.keys()].find((name) => name.startsWith(CONFIG_VARIABLE_PREFIX));
  return variable === undefined ? null : `${variable}=${environment.get(variable)}`;
}

function configChangeIn(call: string, callCwd: string): string | null {
  for (const step of call ? shell.steps(call, callCwd) : []) {
    const index = shell.gitSubcommandIndex(step.argv);
    if (index !== null && changesConfig(step.argv[index] ?? "", step.argv.slice(index + 1))) return shellJoin(step.argv);
  }
  return null;
}

function ghDefaultChangeIn(call: string, callCwd: string): string | null {
  for (const step of shell.steps(call, callCwd)) {
    const words = shell.ghSubcommandArgv(step.argv);
    const setsDefault = arraysEqual(words.slice(1, 3), ["repo", "set-default"]);
    if (step.name === "gh" && setsDefault && !words.slice(3).some((word) => GH_DEFAULT_VIEW_OPTIONS.has(word))) {
      return shellJoin(step.argv);
    }
  }
  return configChangeIn(call, callCwd);
}

function shellJoin(words: readonly string[]): string {
  return words.map(shlexQuote).join(" ");
}

function changesConfig(subcommand: string, args: string[]): boolean {
  if (subcommand === "config") return writesPushRouting(args);
  if (subcommand === "remote") {
    const operand = args.find((arg) => !arg.startsWith("-"));
    return operand !== undefined && REMOTE_EDITS.has(operand);
  }
  return false;
}

function writesPushRouting(configArgs: string[]): boolean {
  if (shell.isConfigRead(configArgs)) return false;
  const key = shell.configKey(configArgs);
  return key === null || routesPushes(key);
}

function routesPushes(key: string): boolean {
  return PUSH_ROUTING_SECTIONS.has(partition(key, ".")[0].toLowerCase());
}

export function parsePush(words: string[], args: string[], workdir: string): Push {
  const pushed = shell.readPushArguments(args);
  const given = pushed.refspecs.map((spec) => lstripChar(spec, "+"));
  const refspecs = given.filter((spec) => !spec.startsWith(":")).map((spec): Refspec => {
    const [source, , destination] = partition(spec, ":");
    return { source, destination: destination || null };
  });
  const deletes = pushed.longOptions.includes("--delete") || pushed.shortFlags.includes("d");
  return {
    kind: "push", workdir, words, remote: pushed.remote, refspecs,
    deletesOnly: deletes || (given.length > 0 && refspecs.length === 0),
    tagsOnly: pushed.longOptions.includes("--tags") && given.length === 0,
    wholeRepo: pushed.wholeRepo,
    dryRun: pushed.longOptions.includes("--dry-run") || pushed.shortFlags.includes("n"),
  };
}

export function parseMerge(words: string[], workdir: string, repoEnv: string | null): Merge {
  let repoFlag: string | null = null;
  let selector: string | null = null;
  let matchHead: string | null = null;
  let auto = false;
  const remaining = words.slice(3).values();
  for (const arg of remaining) {
    const attachedRepo = shell.attachedGhRepo(arg);
    if (shell.GH_REPO_OPTIONS.has(arg)) {
      repoFlag = nextOrNull(remaining);
    } else if (attachedRepo !== null) {
      repoFlag = attachedRepo;
    } else if (arg === "--match-head-commit") {
      matchHead = nextOrNull(remaining);
    } else if (arg.startsWith("--match-head-commit=")) {
      matchHead = partition(arg, "=")[2];
    } else if (arg === "--auto") {
      auto = true;
    } else if (MERGE_VALUE_FLAGS.has(arg)) {
      remaining.next();
    } else if (!arg.startsWith("-") && selector === null) {
      selector = arg;
    }
  }
  return { kind: "merge", workdir, words, selector, repoFlag, repoEnv, auto, matchHead };
}

function nextOrNull(words: ArrayIterator<string>): string | null {
  const next = words.next();
  return next.done ? null : next.value;
}

function judgeAction(action: Action, report: Report): void {
  const hint = (action.kind === "unattributable" && action.userCommand) || userCommand(action.workdir, action.words);
  const irreversible = action.kind !== "prCreate";
  let target: Target;
  try {
    target = resolveTarget(action, report);
  } catch (error) {
    if (error instanceof UnclearTarget) {
      denyUnclearTarget(action, error, report);
    } else {
      report.error(error, irreversible && registry.gatesAnyRepo(), hint);
    }
    return;
  }
  const [repoRoot, repoKey, row] = target;
  const gated = registry.isGated(row);
  try {
    if (action.kind === "push") judgePush(action, repoRoot, repoKey, row, report, hint);
    else if (action.kind === "merge") judgeMerge(action, repoRoot, repoKey, row, report, hint);
    else if (action.kind === "unattributable") denyUnattributable(action, repoKey, report, hint);
    else earlyWarning(repoRoot, repoKey, row, report);
  } catch (error) {
    report.error(error, irreversible && gated, hint, repoKey);
  }
}

function userCommand(workdir: string, words: readonly string[]): string {
  return `cd ${shlexQuote(workdir)} && ${shellJoin(words)}`;
}

function resolveTarget(action: Action, report: Report): Target {
  const repoRoot = gitcmd.toplevel(action.workdir);
  if (repoRoot === null) throw new GateError("not a git repository: " + action.workdir);
  const repoKey = targetKey(action, repoRoot);
  if (!isFile(registry.registryPath())) {
    warnRegistryAbsentOnce(report);
    return [repoRoot, repoKey, null];
  }
  return [repoRoot, repoKey, registry.lookup(repoKey)];
}

function targetKey(action: Action, repoRoot: string): string | null {
  if (action.kind === "push") return pushTargetKey(action, repoRoot);
  if (action.kind === "merge") return mergeTargetKey(action) ?? ghDefaultKey(repoRoot);
  return registry.originKey(repoRoot);
}

function pushTargetKey(push: Push, repoRoot: string): string {
  const remote = push.remote || gitcmd.pushRemote(repoRoot);
  const urls = gitcmd.pushUrls(repoRoot, remote);
  const keys = (urls.length > 0 ? urls : [remote]).map((url) => registry.normalizeRepoKey(located(url, repoRoot)));
  const known = keys.filter((key): key is string => key !== null);
  if (known.length < keys.length) throw new UnclearTarget(`the push target \`${remote}\` resolves to no URL or existing path`);
  return judgedKey(known, registry.originKey(repoRoot));
}

function located(url: string, repoRoot: string): string | null {
  if (URL_FORM.test(url)) return url;
  const path = normalizePath(joinPath(repoRoot, url));
  return existsSync(path) ? path : null;
}

function judgedKey(keys: string[], ownKey: string | null): string {
  const gated = keys.filter((key) => registry.isGated(registry.lookup(key)));
  return gated.find((key) => key !== ownKey) ?? (gated.length > 0 ? gated : keys)[0]!;
}

function repoNamingSources(merge: Merge): Array<[source: string, name: string | null]> {
  const pullUrl = PULL_URL.exec(merge.selector ?? "");
  return [["--repo", merge.repoFlag], ["GH_REPO", merge.repoEnv], ["the PR URL", pullUrl && pullUrl[1]!]];
}

export function mergeTargetKey(merge: Merge): string | null {
  for (const [source, name] of repoNamingSources(merge)) {
    if (!name) continue;
    const key = registry.normalizeRepoKey(name);
    if (key === null) throw new GateError(`${source} ${name} does not name owner/repo`);
    return key;
  }
  return null;
}

function ghDefaultKey(repoRoot: string): string | null {
  const standard = gitcmd.ghDefaultRemote(repoRoot);
  if (standard && standard.resolved !== gitcmd.GH_RESOLVED_BASE) {
    const stored = registry.normalizeRepoKey(standard.resolved);
    if (stored === null) {
      throw new GateError(`gh's default repo ${pyRepr(standard.resolved)} on remote ${standard.remote} names no owner/repo`);
    }
    return stored;
  }
  if (standard) return registry.normalizeRepoKey(gitcmd.remoteUrl(repoRoot, standard.remote));
  const named = new Set<string>();
  for (const name of gitcmd.remotes(repoRoot)) {
    const key = registry.normalizeRepoKey(gitcmd.remoteUrl(repoRoot, name));
    if (key !== null) named.add(key);
  }
  const keys = sortedStrings(named);
  if (keys.length <= 1) return keys[0] ?? null;
  const gated = keys.filter((key) => registry.isGated(registry.lookup(key)));
  if (gated.length > 0) {
    throw new UnclearTarget(
      `gh pr merge names no repo and this clone's remotes point at ${keys.join(", ")}; add \`--repo <owner/repo>\``,
      ["--repo", gated[0]!],
    );
  }
  return registry.originKey(repoRoot);
}

function warnRegistryAbsentOnce(report: Report): void {
  const stamp = joinPath(stateDir(), "sessions", `${valueText(report.session)}.registry-warned`);
  if (existsSync(stamp)) return;
  mkdirSync(pathDirname(stamp), { recursive: true });
  writeFileSync(stamp, "");
  report.warn(
    [{ ruleId: K1, text: `no gated-repos.tsv in the overlay (${registry.registryPath()}): every repo is off` }],
    "registry absent",
  );
}

function judgePush(push: Push, repoRoot: string, repoKey: string | null, row: GatedRepo | null, report: Report, hint: string): void {
  if (!registry.isGated(row) || push.deletesOnly || push.tagsOnly || push.dryRun) {
    report.passed(repoKey, { head: gitcmd.commitSha(repoRoot, pushSources(push)[0] ?? HEAD) });
    return;
  }
  const gatedRow = row!;
  const gatedKey = repoKey!;
  const foreign = foreignCloneReason(repoRoot, gatedKey, "git push");
  if (foreign) {
    report.deny([foreign], `push to ${gatedKey} denied`, hint, { repo: gatedKey });
    return;
  }
  if (push.wholeRepo) {
    report.deny(
      [{ ruleId: F_IRREVERSIBLE, text: "git push --all/--mirror cannot be attributed to one branch; push one branch" }],
      `push of every branch in ${gatedKey} denied`, hint, { repo: gatedKey },
    );
    return;
  }
  for (const spec of push.refspecs.length > 0 ? push.refspecs : [{ source: HEAD, destination: null }]) {
    const head = gitcmd.commitSha(repoRoot, spec.source);
    if (head === null) throw new GateError(`refspec source ${spec.source} does not name a commit`);
    if (pushesTag(repoRoot, spec)) {
      report.passed(gatedKey, { head });
      continue;
    }
    const baseRef = resolveBase(repoRoot, gatedRow);
    const outgoing = outgoingOf(repoRoot, gatedKey, gatedRow, head, baseRef, registry.pushNeedsApproval(gatedRow));
    report.decide(verify.judge(outgoing), `push of ${spec.source} in ${gatedKey} denied`, hint, gatedKey, head);
  }
}

function pushesTag(repoRoot: string, spec: Refspec): boolean {
  if (spec.destination !== null) return spec.destination.startsWith(TAG_PREFIX);
  return spec.source.startsWith(TAG_PREFIX) || gitcmd.refExists(repoRoot, TAG_PREFIX + spec.source);
}

function judgeMerge(merge: Merge, repoRoot: string, repoKey: string | null, row: GatedRepo | null, report: Report, hint: string): void {
  if (!registry.isGated(row)) {
    report.passed(repoKey);
    return;
  }
  const gatedRow = row!;
  const gatedKey = repoKey!;
  const summary = `merge of PR ${merge.selector || "(current branch)"} in ${gatedKey} denied`;
  const foreign = foreignCloneReason(repoRoot, gatedKey, "gh pr merge");
  if (foreign) {
    report.deny([foreign], summary, hint, { repo: gatedKey });
    return;
  }
  if (!merge.matchHead) {
    report.deny(
      [{ ruleId: F_IRREVERSIBLE, text: "gh pr merge needs --match-head-commit <sha> so the gate knows what merges" }],
      summary, hint, { repo: gatedKey },
    );
    return;
  }
  const pullRequest = fetchPullRequest(merge);
  const notGreen = checksNotGreen(pullRequest, merge.auto);
  if (notGreen.length > 0) {
    report.deny(
      [{ ruleId: F_IRREVERSIBLE, text: "checks not green: " + notGreen.join(", ") }],
      summary, hint, { repo: gatedKey, head: merge.matchHead },
    );
    return;
  }
  const head = fetchedCommit(repoRoot, merge.matchHead);
  const baseRef = fetchedRemoteBranch(repoRoot, pullRequest["baseRefName"]);
  const outgoing = outgoingOf(repoRoot, gatedKey, gatedRow, head, baseRef, true);
  report.decide(verify.judge(outgoing), summary, hint, gatedKey, head);
}

function foreignCloneReason(repoRoot: string, repoKey: string, command: string): Reason | null {
  const clone = registry.originKey(repoRoot);
  if (clone === repoKey) return null;
  return {
    ruleId: F_IRREVERSIBLE,
    text: `run ${command} from a clone of ${repoKey} (this clone is ${clone || "without an origin"}); the gate reads the head and base there`,
  };
}

function fetchPullRequest(merge: Merge): Record<string, unknown> {
  const argv = [process.env["KEEL_GH"] || "gh", "pr", "view"];
  if (merge.selector) argv.push(merge.selector);
  if (merge.repoFlag) argv.push("--repo", merge.repoFlag);
  argv.push("--json", PR_VIEW_FIELDS);
  const environment = merge.repoEnv ? { ...process.env, GH_REPO: merge.repoEnv } : undefined;
  const completed = runCaptured(argv, { cwd: merge.workdir, env: environment, timeoutSeconds: GH_TIMEOUT_SECONDS });
  if (completed.returncode !== 0) {
    throw new GateError("gh pr view failed: " + pyStrip(universalNewlines(decodeStrict(completed.stderr))));
  }
  const pullRequest: unknown = pythonJsonLoads(universalNewlines(decodeStrict(completed.stdout)));
  if (!isJsonObject(pullRequest) || !pyTruthy(pullRequest["baseRefName"])) throw new GateError("gh pr view returned no baseRefName");
  return pullRequest;
}

export function checksNotGreen(pullRequest: Record<string, unknown>, auto: boolean): string[] {
  const notGreen: string[] = [];
  for (const check of iterate(pullRequest["statusCheckRollup"])) {
    if (!isJsonObject(check)) throw new AttributeError(`'${valueTypeName(check)}' object has no attribute 'get'`);
    const outcome = firstTruthy("", getField(check, "conclusion"), getField(check, "status"), getField(check, "state"));
    if (isBlocking(outcome, auto)) {
      notGreen.push(`${valueText(firstTruthy("?", getField(check, "name"), getField(check, "context")))}=${valueText(outcome)}`);
    }
  }
  return notGreen;
}

function iterate(value: unknown): unknown[] {
  if (!pyTruthy(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (isJsonObject(value)) return Object.keys(value);
  throw new TypeError(`'${valueTypeName(value)}' object is not iterable`);
}

function firstTruthy(fallback: unknown, ...values: unknown[]): unknown {
  return values.find(pyTruthy) ?? fallback;
}

function isBlocking(outcome: unknown, auto: boolean): boolean {
  if (Array.isArray(outcome) || isJsonObject(outcome)) {
    const type = valueTypeName(outcome);
    throw new TypeError(`cannot use '${type}' as a set element (unhashable type: '${type}')`);
  }
  if (typeof outcome !== "string") return false;
  return FAILED_CHECKS.has(outcome) || (!auto && PENDING_CHECKS.has(outcome));
}

function denyUnattributable(action: Unattributable, repoKey: string | null, report: Report, hint: string): void {
  report.deny(
    [{
      ruleId: K1,
      text: `cannot attribute this push or merge to one repo and branch: ${action.why}; run ` +
        "`git push <remote> <branch>` or `gh pr merge <number> --match-head-commit <sha>` plainly",
    }],
    `unattributable push or merge in ${repoKey || action.workdir} denied`, hint, { repo: repoKey },
  );
}

function denyUnclearTarget(action: Action, unclear: UnclearTarget, report: Report): void {
  const words = [...action.words, ...unclear.addedWords];
  denyUnattributable(unattributable(action.workdir, words, unclear.message), null, report, userCommand(action.workdir, words));
}

function resolveBase(repoRoot: string, row: GatedRepo): string {
  const baseRef = "origin/" + row.integrationBase;
  if (!gitcmd.refExists(repoRoot, "refs/remotes/" + baseRef)) throw new GateError(`base ${baseRef} is missing: run \`git fetch origin\``);
  return baseRef;
}

function outgoingOf(
  repoRoot: string, repoKey: string, row: GatedRepo, head: string, baseRef: string, needsApproval: boolean,
): verify.Outgoing {
  const mergeBase = gitcmd.mergeBase(repoRoot, baseRef, head);
  if (mergeBase === null) throw new GateError(`no merge base between ${baseRef} and ${Array.from(head).slice(0, 10).join("")}`);
  return { repoRoot, repoKey, row, head, mergeBase, needsApproval };
}

function fetchedCommit(repoRoot: string, sha: string): string {
  if (gitcmd.commitSha(repoRoot, sha) === null) gitcmd.fetch(repoRoot, ["origin"]);
  const head = gitcmd.commitSha(repoRoot, sha);
  if (head === null) throw new GateError(`commit ${sha} is not in this clone even after fetching origin`);
  return head;
}

function fetchedRemoteBranch(repoRoot: string, name: unknown): string {
  if (typeof name !== "string") throw new TypeError(`can only concatenate str (not "${valueTypeName(name)}") to str`);
  if (!gitcmd.refExists(repoRoot, "refs/remotes/origin/" + name)) gitcmd.fetch(repoRoot, ["origin"]);
  if (!gitcmd.refExists(repoRoot, "refs/remotes/origin/" + name)) {
    throw new GateError(`origin/${name} is not in this clone even after fetching origin`);
  }
  return "origin/" + name;
}

function earlyWarning(repoRoot: string, repoKey: string | null, row: GatedRepo | null, report: Report): void {
  if (!registry.isGated(row)) return;
  const head = gitcmd.commitSha(repoRoot, HEAD);
  if (head === null) return;
  const branch = gitcmd.currentBranch(repoRoot);
  const baseRef = resolveBase(repoRoot, row!);
  const decision = verify.judge(outgoingOf(repoRoot, repoKey!, row!, head, baseRef, true));
  const label = `${branch || Array.from(head).slice(0, 10).join("")} of ${repoKey} (risk ${decision.riskClass || "none"})`;
  const where = { repo: repoKey, head, risk: decision.riskClass, root_run_id: decision.rootRunId };
  if (decision.ok) {
    report.warn([{ ruleId: K1, text: "review, tests and approval cover the outgoing change" }], "ready to ship " + label, where);
  } else {
    report.warn(decision.reasons, "not ready to ship " + label, where);
  }
}

function collectGarbageIfDue(report: Report): void {
  const stamp = joinPath(stateDir(), "gc.stamp");
  try {
    if (existsSync(stamp) && Date.now() / 1000 - statSync(stamp).mtimeMs / 1000 < GC_INTERVAL_SECONDS) return;
    mkdirSync(pathDirname(stamp), { recursive: true });
    touch(stamp);
    report.record(`evidence gc deleted ${gc.collect()}`);
  } catch (error) {
    report.error(error, false, "");
  }
}

function touch(path: string): void {
  closeSync(openSync(path, "a"));
  const now = new Date();
  utimesSync(path, now, now);
}

function message(summary: string, reasons: readonly Reason[], userCommandText: string | null = null): string {
  const bullets = reasons.map((reason): protocol.Bullet => [reason.ruleId, reason.text]);
  if (userCommandText === null) return protocol.formatWarning(HOOK, summary, bullets);
  return protocol.formatMessage(HOOK, summary, bullets, protocol.runYourself(userCommandText));
}

if (import.meta.main) process.exitCode = main();
