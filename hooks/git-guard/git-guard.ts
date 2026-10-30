import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { shlexQuote } from "../../measure/lib/measurekit/shlex.ts";
import { approvedFastForward } from "../../lib/evidence/activation.ts";
import { boundaryScanner, dataDir, keelHome, overlayDir, overlayPath } from "../lib/hookkit/env.ts";
import { FireLog } from "../lib/hookkit/fires.ts";
import * as knownvalues from "../lib/hookkit/knownvalues.ts";
import { readTsv } from "../lib/hookkit/overlay.ts";
import * as protocol from "../lib/hookkit/protocol.ts";
import type { Payload } from "../lib/hookkit/protocol.ts";
import { basename, expandUser, joinPath, normalizePath } from "../lib/hookkit/paths.ts";
import { editTarget, FieldTypeError, getField, isNonEmptyString, isRecord, jsonTypeName, textField } from "../lib/hookkit/fields.ts";
import { partition, SPACE_CHARS, SPACE_CLASS, splitlines, testCaseFolded, trimSpace, truncate, WORD_BOUNDARY } from "../lib/hookkit/text.ts";
import { compareCodePoints } from "../../measure/lib/measurekit/json.ts";
import { PROCEDURAL_KIND } from "../../measure/lib/measurekit/fireslog.ts";
import { globMatches } from "../../lib/evidence/glob.ts";
import { parseJson, parseJsonReadingNonFiniteNumbersAsZero, parsePayload } from "../lib/hookkit/json.ts";
import { isDirectory, isFile, isSymlink, resolveSymlinksKeepingMissingTail, tryReadText } from "../lib/hookkit/files.ts";
import { AttributeError, describeError, errorName, pythonTypeName, RecursionError, ValueError } from "../lib/hookkit/errors.ts";
import { readStdin } from "../lib/hookkit/stdio.ts";
import { addedComments, withStraightQuotes } from "./comments.ts";
import { notebookCellChange } from "./notebook.ts";
import type { CodeChange } from "./notebook.ts";
import { currentBranch, findRepoKey, findToplevel, git, gitOutput, isCommit } from "../lib/hookkit/repo.ts";
import {
  fileWriteOf, ghSubcommandArgv, gitDirectory, gitSubcommandIndex, isConfigRead, operands, readPushArguments, resolveDirectory, steps, writeTargets,
} from "../lib/hookkit/shell.ts";
import type { Step } from "../lib/hookkit/shell.ts";
import { OSError, run, TimeoutExpired } from "../lib/hookkit/subprocess.ts";
import type { CompletedProcess } from "../lib/hookkit/subprocess.ts";

const HOOK = "git-guard";
const K1 = "K1";
const F_ATTRIBUTION = "F-attribution";
const F_SECRETS = "F-secrets";
const F_FORCE_PUSH = "F-force-push";
const F_HOOKSKIP = "F-hookskip";
const C_ISOLATION = "C-isolation";
const C_COMMENTS = "C-comments";
const STDOUT_FD = "1";
const READ_WRITE_REDIRECT = "<>";
const TEE_SHORT_APPEND = /^-[^-]*a/u;
export const DROP_COMMENTS = "Remove the listed comment lines and resubmit the edit; put the reasoning in the reading guide.";
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "notebookedit", "multiedit"]);
const REPO_RULES_HEADER = ["origin_glob", "action", "pattern", "rule_id", "message"] as const;
const GATED_REPOS_HEADER = ["origin", "gate", "integration_base", "risk_rules", "tests"] as const;
const GATED_REPOS_OPTIONAL = ["push_approval", "auto_merge"] as const;
const ACTION_DENY_COMMIT = "deny-commit";
const ACTION_DENY_PATH = "deny-path";
const ALWAYS_PROTECTED_BRANCHES = ["main", "master"];
export const BOUNDARY_TIMEOUT_SECONDS = 8;
const BOUNDARY_EXIT_CLEAN = 0;
const BOUNDARY_EXIT_HITS = 1;
const COMMIT_MESSAGE_OPTIONS: ReadonlySet<string> = new Set(["-m", "--message"]);
const COMMIT_FILE_OPTIONS: ReadonlySet<string> = new Set(["-F", "--file"]);
const COMMIT_STAGING_LONG_OPTIONS: ReadonlySet<string> = new Set(["--all"]);
const COMMIT_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--message", "--file", "--author", "--date", "--cleanup", "--fixup", "--squash", "--reuse-message",
  "--reedit-message", "--template", "--trailer", "--pathspec-from-file",
]);
const COMMIT_STAGING_SHORT_FLAGS: ReadonlySet<string> = new Set(["a"]);
const COMMIT_SHORT_VALUE_FLAGS: ReadonlySet<string> = new Set(["m", "F", "C", "c", "t"]);
const COMMIT_SHORT_ATTACHED_VALUE_FLAGS: ReadonlySet<string> = new Set(["S", "u"]);
const COMMIT_NO_VERIFY_SHORT_FLAG = "n";
const STAGING_SUBCOMMANDS: ReadonlySet<string> = new Set(["add", "stage"]);
const PR_FILE_OPTIONS: ReadonlySet<string> = new Set(["-F", "--body-file"]);
const PR_TEXT_SUBCOMMANDS: ReadonlySet<string> = new Set(["create", "edit", "merge"]);
const UNPUSHED = ["--not", "--remotes"];
const STDIN_PATH = "-";
const KEEL_CLI_NAME = "keel";
const HOOKED_SUBCOMMANDS: ReadonlySet<string> = new Set(["commit", "merge", "push"]);
const LIVE_MOVING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "checkout", "switch", "restore", "reset", "add", "rm", "mv", "commit", "cherry-pick", "revert", "am", "apply",
  "merge", "rebase", "pull", "stash", "clean",
]);
const HOOKS_PATH_KEY = "core.hookspath";
const DISABLE_HOOKS_KEY = "disableAllHooks";
const DISABLE_HOOKS_RE = new RegExp(`"?disableAllHooks"?[${SPACE_CHARS}]*[:=][${SPACE_CHARS}]*true`, "u");
const SETTINGS_OPTIONS = ["--settings"];
const DISALLOWED_TOOLS_OPTIONS = ["--disallowedTools", "--disallowed-tools"];
const AGENT_WRITE_TOOLS = ["Bash", "Edit", "Write"];
const FIRES_LOG = joinPath("logs", "keel-fires.jsonl");
const KNOWN_VALUES_FILE = ["git-guard", "known-values.tsv"] as const;
const NOT_TEXT_PATH = "(a path that is not text)";
const PROTECTED_TEXT: Readonly<Record<string, string>> = {
  [K1]: "Evidence is written only by keel itself, never by a tool call: %s.",
  [F_HOOKSKIP]: "keel-fires.jsonl is written only by the hooks, never by a tool call: %s.",
};

const AI_TOOLS = "(claude|anthropic|codex|openai)";
const ATTRIBUTION_RE = new RegExp(
  `co-authored-by:${SPACE_CLASS}*${AI_TOOLS}` +
  `|(generated|created|written|authored|co-authored|assisted|aided|helped|powered|built|made|developed` +
  `|drafted|produced|crafted|implemented|reviewed)${SPACE_CLASS}+(with|by|using|via)${SPACE_CLASS}[^\\n]{0,24}${AI_TOOLS}` +
  `|${AI_TOOLS}[${SPACE_CHARS}._-]+(generated|assisted|authored|written|created|powered)` +
  `|(help|assistance|thanks)${SPACE_CLASS}+(of|from|to)${SPACE_CLASS}[^\\n]{0,16}${AI_TOOLS}` +
  `|(https?://|//|@)(anthropic|claude)\\.(com|ai)|(anthropic|claude)\\.(com|ai)/` +
  "|\u{1F916}",
  "iu",
);
const LOOKS_GUARDED_RE = new RegExp(
  `${WORD_BOUNDARY}git${WORD_BOUNDARY}[^\\n]*${WORD_BOUNDARY}(commit|push)${WORD_BOUNDARY}` +
  `|${WORD_BOUNDARY}gh${WORD_BOUNDARY}[^\\n]*${WORD_BOUNDARY}pr${WORD_BOUNDARY}[^\\n]*${WORD_BOUNDARY}(create|edit|merge)${WORD_BOUNDARY}` +
  `|${WORD_BOUNDARY}keel[${SPACE_CHARS}"'\\\\]+(approve|evidence)${WORD_BOUNDARY}|state/keel` +
  `|no-verify|hooksPath|disableAllHooks|keel-fires`,
  "iu",
);

interface Violation {
  ruleId: string;
  text: string;
  repo?: string | null;
  kind?: typeof PROCEDURAL_KIND;
}

interface CommitOption {
  stages: boolean;
  skipsHooks: boolean;
  valueName: string | null;
  attachedValue: string | null;
}

function noCommitOption(): CommitOption {
  return { stages: false, skipsHooks: false, valueName: null, attachedValue: null };
}

function valueFollows(option: CommitOption): boolean {
  return option.valueName !== null && option.attachedValue === null;
}

export class GuardError extends Error {
  override name = "GuardError";
}

function main(): number {
  const raw = readStdin();
  let payload: Payload;
  let fires: FireLog;
  let violations: Violation[];
  try {
    payload = parsePayload(raw);
    fires = new FireLog(HOOK, getField(payload, "session_id") as string | null);
    violations = findViolations(payload);
  } catch (error) {
    return failClosed(raw, error);
  }
  if (violations.length === 0) return protocol.EXIT_PASS;
  for (const violation of violations) fires.append(violation.ruleId, "deny", { repo: violation.repo, detail: violation.text, kind: violation.kind });
  const bullets = violations.map((violation): protocol.Bullet => [violation.ruleId, violation.text]);
  return protocol.deny(protocol.formatMessage(HOOK, "blocked", bullets, nextStepFor(payload, violations)));
}

function nextStepFor(payload: Payload, violations: readonly Violation[]): string {
  if (violations.every((violation) => violation.ruleId === C_COMMENTS)) return DROP_COMMENTS;
  if (protocol.toolName(payload) !== "bash") return protocol.ASK_USER;
  const command = commandOf(protocol.toolInput(payload));
  return protocol.runYourself(`cd ${shlexQuote(protocol.cwdOrProcessDirectory(payload))} && ${command}`);
}

function commandOf(toolArgs: Payload): string {
  return textField(toolArgs, "command");
}

function findViolations(payload: Payload): Violation[] {
  const name = protocol.toolName(payload);
  const toolArgs = protocol.toolInput(payload);
  const cwd = protocol.cwdOrProcessDirectory(payload);
  const isEdit = EDIT_TOOLS.has(name);
  if (!isEdit && name !== "bash") return [];
  const found = isEdit ? checkEdit(toolArgs, cwd) : checkBash(commandOf(toolArgs), cwd);
  if (found.length === 0) refuseNonTextCwd(payload);
  return found;
}

function refuseNonTextCwd(payload: Payload): void {
  textField(payload, "cwd");
}

function checkEdit(toolArgs: Payload, cwd: string): Violation[] {
  const { path: target, unreadable } = editTarget(toolArgs);
  if (target === "" && unreadable === null) return [];
  const edits = getField(toolArgs, "edits");
  const editList = Array.isArray(edits) ? edits : [];
  const text = editedText(toolArgs, editList);
  const targetPath = normalizePath(joinPath(cwd, expandUser(target)));
  const judged: Array<[shown: string, path: string]> = [];
  if (target !== "") judged.push([target, targetPath]);
  if (unreadable !== null) judged.push([NOT_TEXT_PATH, normalizePath(cwd)]);
  const found = unique(judged.flatMap(([shown, path]) => editViolations(shown, path, text)));
  if (target !== "") found.push(...commentViolations(toolArgs, editList, target, targetPath));
  if (found.length > 0) return found;
  if (unreadable !== null) throw unreadable;
  if (edits !== null && !Array.isArray(edits)) throw new TypeError(`edits is not a list: '${pythonTypeName(edits)}'`);
  return found;
}

function editViolations(shown: string, path: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const rule = new ProtectedStore().ruleFor(path);
  if (rule) violations.push({ ruleId: rule, text: fillIn(PROTECTED_TEXT[rule] ?? "", shown) });
  const liveRoot = new LiveCheckouts().rootOf(path);
  if (liveRoot) violations.push(liveViolation(shown, liveRoot));
  if (isClaudeSettingsFile(path) && DISABLE_HOOKS_RE.test(text)) violations.push(disableHooksViolation(shown));
  return [...violations, ...knownValueViolations(() => knownvalues.numberedLines(shown, text))];
}

function commentViolations(toolArgs: Payload, edits: readonly unknown[], shown: string, path: string): Violation[] {
  const change = codeChange(toolArgs, edits, path);
  if (change === null) return [];
  const patched = patchedFile(toolArgs, change.before);
  if (patched !== null) return commentViolation(shown, addedComments(change.path, change.before, patched));
  const baselines = [change.before, ...patchRemovedLines(toolArgs)];
  const added = [...new Set(baselines.flatMap((before) => addedComments(change.path, before, change.after)))];
  return commentViolation(shown, added);
}

function patchedFile(toolArgs: Payload, before: string): string | null {
  const hunks = getField(toolArgs, "keel_hunks");
  if (getField(toolArgs, "keel_partial") !== true || !Array.isArray(hunks) || hunks.length === 0) return null;
  if (!hunks.every((hunk) => Array.isArray(hunk) && hunk.every((line) => typeof line === "string"))) return null;
  const lines = (hunks as string[][]).flat();
  const changed = (sign: string) => lines.filter((line) => line.startsWith(sign)).map((line) => line.slice(1)).join("\n");
  if (changed("+") !== getField(toolArgs, "content") || changed("-") !== getField(toolArgs, "keel_removed")) return null;
  let text = before.split("\n");
  let cursor = 0;
  for (const hunk of hunks as string[][]) {
    const oldLines = hunk.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const newLines = hunk.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    const start = linesIndexOf(text, oldLines, cursor);
    if (oldLines.length === 0 || start === -1 || linesIndexOf(text, oldLines, start + 1) !== -1) return null;
    text = [...text.slice(0, start), ...newLines, ...text.slice(start + oldLines.length)];
    cursor = start + newLines.length;
  }
  return text.join("\n");
}

function linesIndexOf(lines: readonly string[], block: readonly string[], from: number): number {
  for (let start = from; start + block.length <= lines.length; start += 1) {
    if (block.every((line, offset) => lines[start + offset] === line)) return start;
  }
  return -1;
}

function commentViolation(shown: string, added: readonly string[]): Violation[] {
  if (added.length === 0) return [];
  return [{ ruleId: C_COMMENTS, text: `${shown} adds or rewrites code comments: ${protocol.listed(added)}. Only tool directives and legal notices may stay.` }];
}

function codeChange(toolArgs: Payload, edits: readonly unknown[], path: string): CodeChange | null {
  const diskText = tryReadText(path);
  if (getField(toolArgs, "new_source") !== null) return notebookCellChange(path, diskText, toolArgs);
  const before = (diskText ?? "").replaceAll("\r\n", "\n");
  const after = fileAfterEdit(toolArgs, edits, before);
  return after === null ? null : { path, before, after };
}

function patchRemovedLines(toolArgs: Payload): string[] {
  const removed = getField(toolArgs, "keel_removed");
  return getField(toolArgs, "keel_partial") === true && typeof removed === "string" ? [removed] : [];
}

function fileAfterEdit(toolArgs: Payload, edits: readonly unknown[], before: string): string | null {
  const content = getField(toolArgs, "content");
  if (typeof content === "string") return content;
  let text = before;
  for (const replacement of [toolArgs, ...edits.filter(isRecord)]) {
    const oldString = getField(replacement, "old_string");
    const newString = getField(replacement, "new_string");
    if (typeof oldString !== "string" || typeof newString !== "string") continue;
    const matched = matchedOldString(text, oldString);
    if (matched === null) return null;
    text = getField(replacement, "replace_all") === true ? text.replaceAll(matched, () => newString) : text.replace(matched, () => newString);
  }
  return text;
}

function matchedOldString(text: string, oldString: string): string | null {
  if (text.includes(oldString)) return oldString;
  const start = withStraightQuotes(text).indexOf(withStraightQuotes(oldString));
  return start === -1 ? null : text.slice(start, start + oldString.length);
}

function fillIn(template: string, value: string): string {
  return template.replace("%s", () => value);
}

function editedText(toolArgs: Payload, edits: readonly unknown[]): string {
  const parts: unknown[] = ["content", "new_string", "new_source"].map((key) => getField(toolArgs, key));
  for (const edit of edits) parts.push(isRecord(edit) ? getField(edit, "new_string") : null);
  return parts.filter((part): part is string => typeof part === "string").join("\n");
}

function checkBash(command: string, cwd: string): Violation[] {
  const call = steps(command, cwd);
  const callHeredocs = call.flatMap((step) => step.heredocs);
  const violations = [
    ...checkKeelCommands(call), ...checkProtectedWrites(call), ...checkLiveCheckouts(call), ...checkHookSkips(call),
    ...checkHookDisablingWrites(call), ...checkCommentWrites(call),
  ];
  call.forEach((step, index) => violations.push(...checkGitOrPr(step, call, index, callHeredocs)));
  return unique(violations);
}

function checkCommentWrites(call: readonly Step[]): Violation[] {
  return call.flatMap((step, index) => {
    const body = stdinBody(call, index);
    if (body === null) return [];
    return shellWrites(step).flatMap(({ target, appends }) => {
      const path = resolveDirectory(step.directory, target, step.expansion);
      const disk = (tryReadText(path) ?? "").replaceAll("\r\n", "\n");
      return commentViolation(target, addedComments(path, disk, appends ? disk + body : body));
    });
  });
}

function stdinBody(call: readonly Step[], index: number): string | null {
  const step = call[index];
  if (step === undefined || !copiesStdin(step)) return null;
  const hereStrings = step.command.redirects.filter((redirect) => redirect.op === "<<<").map((redirect) => redirect.target + "\n");
  const bodies = [...step.heredocs, ...hereStrings];
  if (bodies.length > 0) return bodies.length === 1 ? (bodies[0] ?? null) : null;
  const previous = call[index - 1];
  const pipedFromPrevious = previous !== undefined && previous.command.pipesToNext && !sendsStdoutAway(previous);
  return pipedFromPrevious ? stdinBody(call, index - 1) : null;
}

function sendsStdoutAway(step: Step): boolean {
  const duplicatesStdout = step.command.redirects.some((redirect) =>
    redirect.op === ">&" && (redirect.fd === undefined || redirect.fd === STDOUT_FD) && redirect.target !== STDOUT_FD);
  return duplicatesStdout || stdoutRedirects(step).length > 0;
}

function copiesStdin(step: Step): boolean {
  return step.name === "tee" || (step.name === "cat" && step.argv.slice(1).every((arg) => arg === "-"));
}

function shellWrites(step: Step): Array<{ target: string; appends: boolean }> {
  const redirects = stdoutRedirects(step);
  if (step.name !== "tee") return redirects;
  const args = step.argv.slice(1);
  const optionsEnd = args.includes("--") ? args.indexOf("--") : args.length;
  const appends = args.slice(0, optionsEnd).some((arg) => arg === "--append" || TEE_SHORT_APPEND.test(arg));
  return [...operands("tee", args).map((target) => ({ target, appends })), ...redirects];
}

function stdoutRedirects(step: Step): Array<{ target: string; appends: boolean }> {
  return step.command.redirects.flatMap((redirect) => {
    const write = fileWriteOf(redirect);
    const toStdout = redirect.fd === undefined ? redirect.op !== READ_WRITE_REDIRECT : redirect.fd === STDOUT_FD;
    return write === null || !toStdout ? [] : [write];
  });
}

function checkKeelCommands(call: readonly Step[]): Violation[] {
  const violations: Violation[] = [];
  for (const step of call) {
    const keelArgs = keelArguments(step.argv);
    if (keelArgs[0] === "approve") {
      violations.push({ ruleId: K1, text: "`keel approve` is the user's act; it runs only in the user's own terminal." });
    }
    if (keelArgs[0] === "evidence" && keelArgs[1] === "write-review") {
      violations.push({ ruleId: K1, text: "Review evidence is written by report-gate from a reviewer's report, never by a command." });
    }
  }
  return violations;
}

function keelArguments(argv: readonly string[]): string[] {
  const index = argv.findIndex((word) => basename(word) === KEEL_CLI_NAME);
  return index < 0 ? [] : argv.slice(index + 1);
}

function checkProtectedWrites(call: readonly Step[]): Violation[] {
  const store = new ProtectedStore();
  const hits = new Map<string, string[]>();
  for (const step of call) {
    const targets = writeTargets(step.command);
    for (const path of [...targets.written, ...targets.removed]) {
      collect(hits, store.ruleFor(resolveDirectory(step.directory, path, step.expansion)), path);
    }
    if (targets.unknown) collect(hits, store.ruleFor(step.directory), step.directory);
  }
  return Array.from(hits, ([rule, paths]) => ({ ruleId: rule, text: fillIn(PROTECTED_TEXT[rule] ?? "", protocol.listed(paths)) }));
}

function collect(hits: Map<string, string[]>, rule: string | null, path: string): void {
  if (!rule) return;
  const paths = hits.get(rule) ?? [];
  paths.push(path);
  hits.set(rule, paths);
}

export function checkLiveCheckouts(call: readonly Step[]): Violation[] {
  const live = new LiveCheckouts();
  if (live.roots.length === 0) return [];
  const found: Array<[what: string, root: string | null]> = [];
  for (const step of call) {
    const targets = writeTargets(step.command);
    for (const path of [...targets.written, ...targets.removed]) {
      const [root, unresolvedCd] = liveRootOfWrite(live, step, path, call[0]?.directory ?? "");
      found.push([unresolvedCd ? `${path} (after a \`cd\` the hook cannot resolve, judged where the call starts)` : path, root]);
    }
    const index = gitSubcommandIndex(step.argv);
    const subcommand = index === null ? undefined : step.argv[index];
    if (index !== null && subcommand !== undefined && LIVE_MOVING_SUBCOMMANDS.has(subcommand)) {
      const toplevel = findToplevel(gitDirectory(step.argv, step.directory, step.expansion));
      if (toplevel && live.rootOf(toplevel) === toplevel && isApprovedFastForward(step.argv.slice(index), toplevel)) continue;
      found.push([`git ${subcommand}`, toplevel ? live.rootOf(toplevel) : null]);
    }
  }
  return found.flatMap(([what, root]) => (root ? [liveViolation(what, root)] : []));
}

function isApprovedFastForward(args: readonly string[], repo: string): boolean {
  if (args.length !== 3 || args[0] !== "merge" || args[1] !== "--ff-only") return false;
  return approvedFastForward(repo, args[2] ?? "");
}

function liveViolation(what: string, root: string): Violation {
  const parent = basename(root);
  return {
    ruleId: C_ISOLATION,
    text: `${what} is inside the live checkout ${root}. Work in a worktree: \`git -C ${root} worktree add ../${parent}-wt/<topic> -b <topic>\`; ` +
      `the live checkout needs an exact-commit owner-approved, gate-verified fast-forward; otherwise the user runs \`git -C ${root} merge --ff-only <branch>\`.`,
  };
}

function checkHookDisablingWrites(call: readonly Step[]): Violation[] {
  const targets = writtenPaths(call).filter(isClaudeSettingsFile);
  if (targets.length === 0 || !DISABLE_HOOKS_RE.test(callText(call))) return [];
  return [disableHooksViolation(protocol.listed(targets))];
}

function disableHooksViolation(target: string): Violation {
  return { ruleId: F_HOOKSKIP, text: `${target} would set ${DISABLE_HOOKS_KEY}, switching keel's hooks off.` };
}

function writtenPaths(call: readonly Step[]): string[] {
  return call.flatMap((step) => writeTargets(step.command).written.map((path) => resolveDirectory(step.directory, path, step.expansion)));
}

function callText(call: readonly Step[]): string {
  const parts = call.flatMap((step) => [...step.argv, ...step.heredocs]);
  parts.push(...call.flatMap((step) => step.command.assignments.map(([, value]) => value)));
  return parts.join("\n");
}

function checkHookSkips(call: readonly Step[]): Violation[] {
  const violations: Violation[] = [];
  for (const step of call) {
    if (step.name === "claude" && childClaudeDisablesHooks(step.argv.slice(1))) {
      violations.push({
        ruleId: F_HOOKSKIP,
        text: `A child \`claude --settings\` carrying ${DISABLE_HOOKS_KEY} runs with keel's hooks off; drop it, or disallow Bash, Edit ` +
          "and Write for that child.",
      });
    }
    const index = gitSubcommandIndex(step.argv);
    const why = index === null ? null : gitHookSkip(step, index);
    if (why) violations.push({ ruleId: F_HOOKSKIP, text: why + " The repo's hooks run keel's checks; run the command without it." });
  }
  return violations;
}

function childClaudeDisablesHooks(args: readonly string[]): boolean {
  const inlineSettings = optionValues(args, SETTINGS_OPTIONS).filter((value) => trimSpace(value).startsWith("{"));
  if (!inlineSettings.some(settingsDisableHooks)) return false;
  const disallowed = new Set(optionValues(args, DISALLOWED_TOOLS_OPTIONS).flatMap(
    (value) => value.split(new RegExp(`[,${SPACE_CHARS}]+`)).filter((tool) => tool !== "")));
  return !AGENT_WRITE_TOOLS.every((tool) => disallowed.has(tool));
}

function optionValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < args.length) {
    const word = args[index] ?? "";
    if (names.includes(word)) {
      index += 1;
      while (index < args.length && !(args[index] ?? "").startsWith("-")) {
        values.push(args[index] ?? "");
        index += 1;
      }
      continue;
    }
    if (names.some((name) => word.startsWith(name + "="))) values.push(partition(word, "=")[2]);
    index += 1;
  }
  return values;
}

function settingsDisableHooks(text: string): boolean {
  let settings: unknown;
  try {
    settings = parseJsonReadingNonFiniteNumbersAsZero(text);
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    return DISABLE_HOOKS_RE.test(text);
  }
  return isRecord(settings) && getField(settings, DISABLE_HOOKS_KEY) === true;
}

function gitHookSkip(step: Step, index: number): string | null {
  const gitGlobals = step.argv.slice(1, index);
  const subcommand = step.argv[index] ?? "";
  const args = step.argv.slice(index + 1);
  const configValues = gitGlobals.map((word) => (word.startsWith("-c") && word.length > 2 ? word.slice(2) : word));
  if (configValues.some((value) => value.toLowerCase().startsWith(HOOKS_PATH_KEY + "="))) {
    return "`-c core.hooksPath=…` points git at other hooks for this command.";
  }
  if (HOOKED_SUBCOMMANDS.has(subcommand) && args.includes("--no-verify")) return `\`git ${subcommand} --no-verify\` skips the repo's hooks.`;
  if (subcommand === "commit" && args.some((arg) => arg.startsWith("-") && readCommitOption(arg).skipsHooks)) {
    return "`git commit -n` skips the repo's hooks.";
  }
  if (subcommand === "config" && args.some((arg) => arg.toLowerCase() === HOOKS_PATH_KEY) && !isConfigRead(args)) {
    return "`git config core.hooksPath` points git at other hooks.";
  }
  return null;
}

function checkGitOrPr(step: Step, call: readonly Step[], index: number, callHeredocs: readonly string[]): Violation[] {
  if (step.name === "gh") return checkPrText(ghSubcommandArgv(step.argv), step, callHeredocs);
  const argv = step.argv;
  const position = gitSubcommandIndex(argv);
  if (position === null) return [];
  const repoDirectory = gitDirectory(argv, step.directory, step.expansion);
  if (argv[position] === "commit") return checkCommit(argv.slice(position + 1), step, repoDirectory, call.slice(0, index), callHeredocs);
  if (argv[position] === "push") return checkPush(argv.slice(position + 1), repoDirectory);
  return [];
}

function checkPrText(ghArgv: readonly string[], step: Step, callHeredocs: readonly string[]): Violation[] {
  if (ghArgv[1] !== "pr" || ghArgv.length < 3 || !PR_TEXT_SUBCOMMANDS.has(ghArgv[2] ?? "")) return [];
  const args = ghArgv.slice(3);
  const texts = [...args, ...callHeredocs, ...readMessageFiles(args, PR_FILE_OPTIONS, step)];
  if (!testCaseFolded(ATTRIBUTION_RE, texts.join("\n"))) return [];
  return [{
    ruleId: F_ATTRIBUTION,
    text: "AI-tool attribution in a PR title or body, a merge commit message, or text this call writes for them; remove it.",
  }];
}

function checkCommit(args: readonly string[], step: Step, repoDirectory: string, earlierSteps: readonly Step[], callHeredocs: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  if (testCaseFolded(ATTRIBUTION_RE, commitMessageTexts(args, step, callHeredocs).join("\n"))) {
    violations.push({ ruleId: F_ATTRIBUTION, text: "AI-tool attribution in the commit message; remove it." });
  }
  const toplevel = findToplevel(repoDirectory);
  if (toplevel === null) return violations;
  const repoKey = findRepoKey(toplevel);
  if (commitStagesFiles(args) || isStagedEarlierInCall(earlierSteps, toplevel)) {
    violations.push({
      ruleId: F_SECRETS, repo: repoKey, kind: PROCEDURAL_KIND,
      text: "This commit stages files in its own call, so the secret and path checks cannot see them; stage in a separate call, then commit.",
    });
  }
  const staged = splitlines(gitOutput(["diff", "--cached", "--name-only"], toplevel) || "");
  violations.push(...repoRuleViolations(repoKey, staged, [ACTION_DENY_COMMIT, ACTION_DENY_PATH]));
  violations.push(...scanStagedSecrets(toplevel, repoKey));
  return [...violations, ...knownValueViolations(
    () => knownvalues.addedLines(gitTextOrRaise(["diff", "--cached", "-U0", "--no-color"], toplevel)), repoKey)];
}

function checkPush(args: readonly string[], repoDirectory: string): Violation[] {
  const toplevel = findToplevel(repoDirectory);
  if (toplevel === null) return [];
  const push = readPush(args, currentBranch(toplevel));
  const repoKey = findRepoKey(toplevel);
  const violations: Violation[] = [];
  if (push.force) {
    violations.push({ ruleId: F_FORCE_PUSH, repo: repoKey, text: "Force push rewrites shared history; push without --force, -f or a +refspec." });
  }
  const leased = push.forceWithLease ? leasedProtectedBranches(push, repoKey) : [];
  if (leased.length > 0) {
    violations.push({ ruleId: F_FORCE_PUSH, repo: repoKey, text: `--force-with-lease onto ${leased.join(", ")} is still a force push to a shared branch.` });
  }
  for (const [revisions, label] of pushedRanges(toplevel, push)) violations.push(...checkPushRange(toplevel, repoKey, revisions, label));
  return violations;
}

function leasedProtectedBranches(push: PushRequest, repoKey: string | null): string[] {
  const protectedNames = new Set(protectedBranches(repoKey));
  return Array.from(push.destinations).filter((name) => protectedNames.has(name)).sort(compareCodePoints);
}

function pushedRanges(toplevel: string, push: PushRequest): Array<[revisions: string[], label: string]> {
  if (push.wholeRepo) return [[["--branches", ...UNPUSHED], "a local branch (not yet on a remote)"]];
  return push.sources.filter((source) => isCommit(toplevel, source)).map((source) => [[source, ...UNPUSHED], `${source} (not yet on a remote)`]);
}

function checkPushRange(toplevel: string, repoKey: string | null, revisions: readonly string[], label: string): Violation[] {
  const violations: Violation[] = [];
  if (testCaseFolded(ATTRIBUTION_RE, gitOutput(["log", "--pretty=%B", ...revisions], toplevel) || "")) {
    violations.push({
      ruleId: F_ATTRIBUTION, repo: repoKey,
      text: `AI-tool attribution in a commit message of ${label}; reword it (last commit: \`git commit --amend\`) before pushing.`,
    });
  }
  const names = trimSpace(gitOutput(["log", "--name-only", "--pretty=", ...revisions], toplevel) || "").split(new RegExp(`${SPACE_CLASS}+`));
  const paths = [...new Set(names.filter((name) => name !== ""))].sort(compareCodePoints);
  return [...violations, ...repoRuleViolations(repoKey, paths, [ACTION_DENY_PATH])];
}

function commitStagesFiles(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "--") return index + 1 < args.length;
    if (!arg.startsWith("-") || arg === STDIN_PATH) return true;
    const option = readCommitOption(arg);
    if (option.stages) return true;
    index += valueFollows(option) ? 2 : 1;
  }
  return false;
}

function isStagedEarlierInCall(earlierSteps: readonly Step[], toplevel: string): boolean {
  return earlierSteps.some((step) => {
    const index = gitSubcommandIndex(step.argv);
    if (index === null || !STAGING_SUBCOMMANDS.has(step.argv[index] ?? "")) return false;
    return findToplevel(gitDirectory(step.argv, step.directory, step.expansion)) === toplevel;
  });
}

export function scanStagedSecrets(toplevel: string, repoKey: string | null, timeoutSeconds: number = BOUNDARY_TIMEOUT_SECONDS): Violation[] {
  let result: CompletedProcess;
  try {
    result = run([boundaryScanner(), "--staged", "--generic-only"], timeoutSeconds, { cwd: toplevel });
  } catch (error) {
    if (!(error instanceof OSError || error instanceof TimeoutExpired)) throw error;
    throw new GuardError(`boundary scanner did not run: ${errorName(error)}`);
  }
  if (result.returncode === BOUNDARY_EXIT_CLEAN) return [];
  if (result.returncode !== BOUNDARY_EXIT_HITS) throw new GuardError(`boundary scanner exit ${result.returncode}`);
  const report = parseJson(result.stdout);
  if (!isRecord(report)) throw noGet(report);
  const described = listOrEmpty(getField(report, "hits"), "hits").map((hit) => {
    if (!isRecord(hit)) throw noGet(hit);
    return `${hitText(hit, "file")}:${hitText(hit, "line")} (${hitText(hit, "rule")})`;
  });
  return [{
    ruleId: F_SECRETS, repo: repoKey,
    text: `Staged lines match a secret or private-address pattern: ${protocol.listed(described)}. Unstage or redact them.`,
  }];
}

function hitText(hit: Record<string, unknown>, key: string): string {
  const value = getField(hit, key);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new FieldTypeError(`hit ${key} must be a string or number, not ${jsonTypeName(value)}`);
}

function listOrEmpty(value: unknown, field: string): unknown[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  throw new TypeError(`${field} is not a list: '${pythonTypeName(value)}'`);
}

function noGet(value: unknown): AttributeError {
  return new AttributeError(`'${pythonTypeName(value)}' object has no attribute 'get'`);
}

function knownValueViolations(readLines: () => Iterable<knownvalues.Line>, repoKey: string | null = null): Violation[] {
  const values = knownvalues.load(overlayPath(...KNOWN_VALUES_FILE));
  const hits = values.length > 0 ? knownvalues.find(readLines(), values) : [];
  if (hits.length === 0) return [];
  return [{ ruleId: F_SECRETS, repo: repoKey, text: `Known secret values written out: ${protocol.listed(hits.map((hit) => hit.describe()))}. Redact them.` }];
}

function repoRuleViolations(repoKey: string | null, paths: readonly string[], actions: readonly string[]): Violation[] {
  if (repoKey === null) return [];
  const violations: Violation[] = [];
  for (const rule of readTsv(overlayPath("git-guard", "repo-rules.tsv"), REPO_RULES_HEADER)) {
    const action = rule["action"] ?? "";
    if (!actions.includes(action) || !globMatches(repoKey, rule["origin_glob"] ?? "")) continue;
    const matched = paths.filter((path) => globMatches(path, rule["pattern"] ?? ""));
    if (action === ACTION_DENY_COMMIT) {
      violations.push({ ruleId: rule["rule_id"] ?? "", text: rule["message"] ?? "", repo: repoKey });
    } else if (matched.length > 0) {
      violations.push({ ruleId: rule["rule_id"] ?? "", text: `${rule["message"]} (${protocol.listed(matched)})`, repo: repoKey });
    }
  }
  return violations;
}

function protectedBranches(repoKey: string | null): string[] {
  const base = findIntegrationBase(repoKey);
  return [...(base ? [base] : []), ...ALWAYS_PROTECTED_BRANCHES];
}

function findIntegrationBase(repoKey: string | null): string | null {
  for (const row of readTsv(overlayPath("gated-repos.tsv"), GATED_REPOS_HEADER, GATED_REPOS_OPTIONAL)) {
    if (repoKey && (row["origin"] ?? "").toLowerCase() === repoKey && row["integration_base"] !== "-") return row["integration_base"] ?? null;
  }
  return null;
}

interface PushRequest {
  sources: string[];
  destinations: Set<string>;
  force: boolean;
  forceWithLease: boolean;
  wholeRepo: boolean;
}

function readPush(args: readonly string[], branch: string | null): PushRequest {
  const pushed = readPushArguments(args);
  const deletes = pushed.longOptions.includes("--delete") || pushed.shortFlags.includes("d");
  const push: PushRequest = {
    sources: [],
    destinations: new Set(),
    force: pushed.longOptions.includes("--force") || pushed.shortFlags.includes("f") || pushed.refspecs.some((spec) => spec.startsWith("+")),
    forceWithLease: pushed.longOptions.some((option) => option.startsWith("--force-with-lease")),
    wholeRepo: pushed.wholeRepo,
  };
  if (pushed.refspecs.length === 0 && !deletes) {
    push.sources = ["HEAD"];
    if (branch) push.destinations.add(branch);
  }
  for (const spec of pushed.refspecs) {
    const [source, , destinationName] = partition(spec.replace(/^\++/, ""), ":");
    if (deletes || !source) continue;
    push.sources.push(source);
    let destination = destinationName || source;
    if (destination === "HEAD") destination = branch || destination;
    push.destinations.add(destination.replace(/^refs\/heads\//, ""));
  }
  return push;
}

class ProtectedStore {
  private readonly trees: Array<[tree: string, rule: string]>;
  private readonly files: Array<[file: string, rule: string]>;

  constructor() {
    const roots = spellings(dataDir());
    this.trees = roots.map((root) => [joinPath(root, "state", "keel"), K1]);
    this.files = roots.map((root) => [joinPath(root, FIRES_LOG), F_HOOKSKIP]);
  }

  ruleFor(path: string): string | null {
    for (const candidate of spellings(path)) {
      for (const [tree, rule] of this.trees) if (candidate === tree || candidate.startsWith(tree + "/")) return rule;
      for (const [file, rule] of this.files) if (candidate === file) return rule;
    }
    return null;
  }
}

class LiveCheckouts {
  readonly roots: string[];

  constructor() {
    this.roots = [keelHome(), overlayDir()].filter(isDirectory).map((root) => realpathSync(root));
  }

  rootOf(path: string): string | null {
    for (const candidate of spellings(path)) {
      const root = this.roots.find((root) => candidate === root || candidate.startsWith(root + "/"));
      if (root && !isInsideLinkedWorktreeOf(root, candidate)) return root;
    }
    return null;
  }
}

function isInsideLinkedWorktreeOf(root: string, path: string): boolean {
  const adminDirs = joinPath(root, ".git", "worktrees") + "/";
  for (let directory = path; directory.startsWith(root + "/"); directory = dirname(directory)) {
    const dotGit = joinPath(directory, ".git");
    if (isDirectory(dotGit)) return false;
    if (isFile(dotGit)) return isRegisteredWorktree(dotGit, adminDirs);
  }
  return false;
}

function isRegisteredWorktree(dotGitFile: string, adminDirs: string): boolean {
  if (isSymlink(dotGitFile)) return false;
  const adminDir = adminDirOf(dotGitFile);
  if (adminDir === null || !adminDir.startsWith(adminDirs)) return false;
  return dotGitFileOf(adminDir) === resolveSymlinksKeepingMissingTail(dotGitFile);
}

function adminDirOf(dotGitFile: string): string | null {
  const [key, separator, value] = partition(trimSpace(tryReadText(dotGitFile) ?? ""), ":");
  if (key !== "gitdir" || separator === "" || trimSpace(value) === "") return null;
  return resolveSymlinksKeepingMissingTail(joinPath(dirname(dotGitFile), trimSpace(value)));
}

function dotGitFileOf(adminDir: string): string | null {
  const recorded = trimSpace(tryReadText(joinPath(adminDir, "gitdir")) ?? "");
  return recorded === "" ? null : resolveSymlinksKeepingMissingTail(joinPath(adminDir, recorded));
}

function isClaudeSettingsFile(path: string): boolean {
  const name = basename(path);
  return basename(dirname(path)) === ".claude" && name.startsWith("settings") && name.endsWith(".json");
}

function failClosed(raw: string, error: unknown): number {
  const { session, command } = salvage(raw);
  new FireLog(HOOK, session).append(F_ATTRIBUTION, "error", { detail: describeError(error) });
  if (!(error instanceof RecursionError) && !testCaseFolded(LOOKS_GUARDED_RE, raw)) return protocol.EXIT_PASS;
  const bullet: protocol.Bullet = [
    F_ATTRIBUTION, `The guard could not check this commit, push, PR text or protected write (${errorName(error)}).`,
  ];
  const nextStep = command ? protocol.runYourself(command) : protocol.ASK_USER;
  return protocol.deny(protocol.formatMessage(HOOK, "internal error on a guarded command; refusing it", [bullet], nextStep));
}

function salvage(raw: string): { session: string | null; command: string | null } {
  const unknown = { session: null, command: null };
  let payload: unknown;
  try {
    payload = parseJson(raw);
  } catch (error) {
    if (error instanceof ValueError || error instanceof RecursionError) return unknown;
    throw error;
  }
  if (!isRecord(payload)) return unknown;
  const command = getField(protocol.toolInput(payload), "command");
  return { session: getField(payload, "session_id") as string | null, command: isNonEmptyString(command) ? command : null };
}

function commitMessageTexts(args: readonly string[], step: Step, callHeredocs: readonly string[]): string[] {
  const texts = [...callHeredocs];
  for (const [name, value] of commitOptionValues(args)) {
    if (COMMIT_MESSAGE_OPTIONS.has(name)) texts.push(value);
    else if (COMMIT_FILE_OPTIONS.has(name)) texts.push(...messageSourceTexts(value, step));
  }
  return texts;
}

function commitOptionValues(args: readonly string[]): Array<[name: string, value: string]> {
  const pairs: Array<[string, string]> = [];
  let index = 0;
  while (index < args.length && args[index] !== "--") {
    const arg = args[index] ?? "";
    const option = arg.startsWith("-") && arg !== STDIN_PATH ? readCommitOption(arg) : noCommitOption();
    if (valueFollows(option) && index + 1 < args.length) {
      pairs.push([option.valueName ?? "", args[index + 1] ?? ""]);
      index += 1;
    } else if (option.attachedValue !== null) {
      pairs.push([option.valueName ?? "", option.attachedValue]);
    }
    index += 1;
  }
  return pairs;
}

function readMessageFiles(args: readonly string[], options: ReadonlySet<string>, step: Step): string[] {
  const texts: string[] = [];
  const longOptions = Array.from(options).filter((option) => option.startsWith("--"));
  args.forEach((arg, index) => {
    if (options.has(arg) && index + 1 < args.length) texts.push(...messageSourceTexts(args[index + 1] ?? "", step));
    else if (longOptions.some((option) => arg.startsWith(option + "="))) texts.push(...messageSourceTexts(partition(arg, "=")[2], step));
  });
  return texts;
}

function messageSourceTexts(path: string, step: Step): string[] {
  const resolved = resolveDirectory(step.directory, path, step.expansion);
  return isFile(resolved) ? [withLfLineEnds(readFileSync(resolved, "utf8"))] : [];
}

function withLfLineEnds(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function readCommitOption(arg: string): CommitOption {
  if (arg.startsWith("--")) {
    const [name, hasInlineValue, inlineValue] = partition(arg, "=");
    const valueName = COMMIT_LONG_VALUE_OPTIONS.has(name) ? name : null;
    return {
      stages: COMMIT_STAGING_LONG_OPTIONS.has(name), skipsHooks: false, valueName,
      attachedValue: valueName && hasInlineValue ? inlineValue : null,
    };
  }
  const option = noCommitOption();
  const flags = Array.from(arg.slice(1));
  for (const [position, flag] of flags.entries()) {
    if (COMMIT_STAGING_SHORT_FLAGS.has(flag)) {
      option.stages = true;
    } else if (flag === COMMIT_NO_VERIFY_SHORT_FLAG) {
      option.skipsHooks = true;
    } else if (COMMIT_SHORT_VALUE_FLAGS.has(flag)) {
      option.valueName = "-" + flag;
      option.attachedValue = flags.slice(position + 1).join("") || null;
      return option;
    } else if (COMMIT_SHORT_ATTACHED_VALUE_FLAGS.has(flag)) {
      return option;
    }
  }
  return option;
}

function gitTextOrRaise(args: readonly string[], toplevel: string): string {
  const result = git(args, toplevel);
  if (result.returncode !== 0) throw new GuardError(`git ${args[0]} failed: ${truncate(trimSpace(result.stderr), 120)}`);
  return result.stdout;
}

function liveRootOfWrite(live: LiveCheckouts, step: Step, path: string, callDirectory: string): [root: string | null, judgedWhereCallStarts: boolean] {
  if (isUnresolved(resolveDirectory("/", path, step.expansion))) return [null, false];
  const resolved = resolveDirectory(step.directory, path, step.expansion);
  if (isUnresolved(resolved)) return [live.rootOf(callDirectory), true];
  return [live.rootOf(resolved), false];
}

function isUnresolved(resolvedPath: string): boolean {
  return resolvedPath.includes("`") || resolvedPath.includes("$");
}

function spellings(path: string): string[] {
  const normalized = normalizePath(path);
  const real = resolveSymlinksKeepingMissingTail(path);
  return real === normalized ? [normalized] : [normalized, real];
}

function unique(violations: readonly Violation[]): Violation[] {
  const first = new Map<string, Violation>();
  for (const violation of violations) {
    const key = JSON.stringify([violation.ruleId, violation.text]);
    if (!first.has(key)) first.set(key, violation);
  }
  return Array.from(first.values());
}

if (import.meta.main) process.exitCode = main();
