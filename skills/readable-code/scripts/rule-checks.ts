import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, closeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type Span = readonly [start: string, end: string | null];
type Added = ReadonlyArray<readonly [lineNumber: number, text: string]>;
type Change = readonly [path: string, beforePath: string, added: Added, removed: number];

interface Signal {
  id: string;
  where: string;
  text: string;
}

interface Summary {
  repos: number;
  scanned: number;
  changed: number;
  unscanned: string[];
  blocked: string[];
}

type ScanTree = (root: string, base: string, head: string | undefined) => { signals: Signal[]; summary: Summary };

const SKILL_DIR = dirname(dirname(realpathSync(import.meta.filename)));
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__"]);
const TEST_BASENAME_GLOBS = ["test_*.py", "*_test.*", "*.test.*", "*.spec.*"];
const WORD = String.raw`\p{L}\p{N}_`;
const SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const NOT_AFTER_WORD = `(?<![${WORD}])`;
const NOT_BEFORE_WORD = `(?![${WORD}])`;
const GENERATED_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.js$|(^|\/)generated\//;
const API_LAYER_PATH = /(^|\/)api[^/]*\//iu;
const CODE_EXT = [".java", ".ts", ".tsx"];
const TS_EXT = [".ts", ".tsx"];
const REACT_EXT = [".ts", ".tsx", ".js", ".jsx"];

const COMMENT_LINE = new RegExp(`^[${SPACE}]*\\*|//|/\\*`, "u");
const TS_SUPPRESSION = new RegExp(`(?://+|/\\*+)[${SPACE}]*@ts-(?:ignore|expect-error)${NOT_BEFORE_WORD}`, "u");
const EXHAUSTIVE_DEPS_DISABLE = new RegExp(
  `(?://|/\\*)[${SPACE}]*eslint-disable(?:-next-line|-line)?[${SPACE}].*${NOT_AFTER_WORD}react-hooks/exhaustive-deps${NOT_BEFORE_WORD}`, "u");
const HISTORY_COMMENT = new RegExp(
  `20[0-9]{2}-[0-9]{2}-[0-9]{2}|(^|[^a-z])(it|this|that|which|we) used to|used to be|no longer|corrected|previously|design §|STAGE [0-9]`, "iu");
const TODO = new RegExp(`${NOT_AFTER_WORD}TODO${NOT_BEFORE_WORD}`, "u");
const TICKET = new RegExp(`${NOT_AFTER_WORD}[A-Z][A-Z0-9]+-\\p{Nd}+${NOT_BEFORE_WORD}`, "u");
const BANNER = /(-{4,}|={4,}|\*{6,}|#{4,})/;
const BANNED_NAMES = "process|handle|do|execute|data|info|result|temp|list|obj|flag|util|manager|helper";
const TS_DECL = new RegExp(`${NOT_AFTER_WORD}(?:const|let|var|function)[${SPACE}]+(${BANNED_NAMES})${NOT_BEFORE_WORD}`, "u");
const JAVA_DECL = new RegExp(
  `${NOT_AFTER_WORD}[A-Z][${WORD}]*(?:<[^>]*>)?(?:\\[\\])?[${SPACE}]+(${BANNED_NAMES})[${SPACE}]*[=;,)(]`, "u");
const ANY_TYPE = new RegExp(`:[${SPACE}]*any${NOT_BEFORE_WORD}|${NOT_AFTER_WORD}as any${NOT_BEFORE_WORD}|<any>`, "u");
const MAP_OBJECT = new RegExp(`Map<String,[${SPACE}]*Object>`, "u");
const UNCHECKED_SUPPRESSION = /@SuppressWarnings\(.*"unchecked"/;
const EMPTY_CATCH = new RegExp(`catch[${SPACE}]*(\\([^)]*\\))?[${SPACE}]*\\{[${SPACE}]*\\}`, "u");
const MESSAGE_ONLY_LOG = new RegExp(`${NOT_AFTER_WORD}log[${WORD}]*\\.[${WORD}]+\\(.*\\.getMessage\\(\\)[${SPACE}]*\\)`, "u");
const USE_STATE = new RegExp(`${NOT_AFTER_WORD}useState${NOT_BEFORE_WORD}`, "gu");
const HEAD_RELATIVE = /^(HEAD|@)([~^]|$)/;
const FOREIGN_SHA = /^[0-9a-fA-F]{7,40}$/;
const HUNK_HEADER = /^@@ -\S+ \+(\d+)/;
const SPLITLINES_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const LEADING_SPACE = new RegExp(`^[${SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${SPACE}]+$`);

const NAMES = "K5.5";
const SIZE = "K5.7";
const HIDDEN_BEHAVIOR = "K5.9";
const TYPES = "K5.11";
const ERRORS = "K5.12";
const COMMENTS = "K5.14";

const DIFF_LINE_SIGNAL = 400;
const COMPONENT_LINE_SIGNAL = 300;
const USE_STATE_SIGNAL = 10;
const CLASS_LINE_SIGNAL = 500;
const SIGNAL_TEXT_LIMIT = 160;
const BINARY_PROBE_BYTES = 8000;
const UNLIMITED_OUTPUT_BYTES = 1 << 30;
const USAGE_ERROR_EXIT = 2;

const GITLINK_MODE = "160000";
const NO_ENTRY_MODE = "000000";
const BLOCKED = "blocked";

const PROG = basename(process.argv[1] ?? "rule-checks.ts");
const USAGE = `usage: ${PROG} [-h] [--repo REPO] [--base BASE] [--head HEAD]\n${" ".repeat(`usage: ${PROG} `.length)}[--self-test]\n`;
const HELP = `${USAGE}\noptions:\n  -h, --help   show this help message and exit\n  --repo REPO\n  --base BASE\n  --head HEAD\n  --self-test\n`;

class RuntimeError extends Error {}

function foldDottedAndDotlessI(text: string): string {
  return text.replace(/[\u0130\u0131]/gu, "i");
}

function splitlines(text: string): string[] {
  const lines = text.split(SPLITLINES_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function pythonStrip(text: string): string {
  return text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

function stripNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") start += 1;
  while (end > start && text[end - 1] === "\n") end -= 1;
  return text.slice(start, end);
}

function truncate(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

function pythonExceptionName(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && typeof (error as NodeJS.ErrnoException).errno === "number") {
    switch (code) {
      case "ENOENT": return "FileNotFoundError";
      case "EACCES": case "EPERM": return "PermissionError";
      case "EISDIR": return "IsADirectoryError";
      case "ENOTDIR": return "NotADirectoryError";
      case "EEXIST": return "FileExistsError";
      default: return "OSError";
    }
  }
  return error instanceof Error ? error.constructor.name : "Exception";
}

function main(): void {
  process.exitCode = runCli(process.argv.slice(2));
}

function runCli(argv: readonly string[], scan: ScanTree = scanTree): number {
  const parsed = parseArguments(argv);
  if (typeof parsed === "number") return parsed;
  if (parsed.selfTest) return runSelfTest();
  if (!parsed.repo || !parsed.base) return usageError("--repo and --base are required");
  let scanResult: { signals: Signal[]; summary: Summary };
  try {
    scanResult = scan(parsed.repo, parsed.base, parsed.head);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
    process.stdout.write(`summary repos=0 scanned_lines=0 signals=0 unscanned=none blocked=.(crashed: ${pythonExceptionName(error)})\n`);
    return 2;
  }
  for (const signal of scanResult.signals) process.stdout.write(`signal ${signal.id} ${signal.where} ${signal.text}\n`);
  process.stdout.write(formatSummary(scanResult.summary, scanResult.signals.length) + "\n");
  return scanResult.summary.blocked.length > 0 ? 2 : 0;
}

interface Arguments {
  repo?: string;
  base?: string;
  head?: string;
  selfTest: boolean;
}

const ALL_FLAGS = ["-h", "--help", "--repo", "--base", "--head", "--self-test"];
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

function usageError(message: string): number {
  process.stderr.write(`${USAGE}${PROG}: error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

interface Candidate {
  flag: string;
  explicit: string | null;
  viaEquals: boolean;
}

type Classified = "positional" | "unknown" | Candidate | { ambiguous: string[] };

function classify(text: string): Classified {
  if (text === "" || !text.startsWith("-")) return "positional";
  if (ALL_FLAGS.includes(text)) return { flag: text, explicit: null, viaEquals: false };
  if (text.length === 1) return "positional";
  const cut = text.indexOf("=");
  if (cut >= 0 && ALL_FLAGS.includes(text.slice(0, cut))) return { flag: text.slice(0, cut), explicit: text.slice(cut + 1), viaEquals: true };
  const matches: Candidate[] = [];
  if (text.startsWith("--")) {
    const prefix = cut < 0 ? text : text.slice(0, cut);
    for (const flag of ALL_FLAGS) {
      if (flag.startsWith(prefix)) matches.push({ flag, explicit: cut < 0 ? null : text.slice(cut + 1), viaEquals: cut >= 0 });
    }
  } else {
    for (const flag of ALL_FLAGS) {
      if (flag === text.slice(0, 2)) matches.push({ flag, explicit: text.slice(2), viaEquals: false });
      else if (flag.startsWith(text)) matches.push({ flag, explicit: null, viaEquals: false });
    }
  }
  if (matches.length > 1) return { ambiguous: matches.map((match) => match.flag) };
  if (matches.length === 1) return matches[0] as Candidate;
  return NEGATIVE_NUMBER.test(text) || text.includes(" ") ? "positional" : "unknown";
}

function parseArguments(argv: readonly string[]): Arguments | number {
  const parsed: Arguments = { selfTest: false };
  const extras: string[] = [];
  const classified: Classified[] = [];
  for (const text of argv) {
    if (text === "--") break;
    classified.push(classify(text));
  }
  let index = 0;
  while (index < argv.length) {
    const text = argv[index] ?? "";
    const found = classified[index];
    index += 1;
    if (found === undefined) {
      extras.push(...argv.slice(index - 1));
      break;
    }
    if (found === "positional" || found === "unknown") {
      extras.push(text);
      continue;
    }
    if ("ambiguous" in found) return usageError(`ambiguous option: ${text} could match ${found.ambiguous.join(", ")}`);
    const name = found.flag === "-h" || found.flag === "--help" ? "-h/--help" : found.flag;
    if (found.flag === "-h" || found.flag === "--help") {
      if (found.explicit !== null && (found.viaEquals || found.flag !== "-h")) return usageError(`argument ${name}: ignored explicit argument '${found.explicit}'`);
      process.stdout.write(HELP);
      return 0;
    }
    if (found.flag === "--self-test") {
      if (found.explicit !== null) return usageError(`argument ${name}: ignored explicit argument '${found.explicit}'`);
      parsed.selfTest = true;
      continue;
    }
    let value = found.explicit;
    if (value === null) {
      if (classified[index] !== "positional") return usageError(`argument ${name}: expected one argument`);
      value = argv[index] ?? "";
      index += 1;
    }
    parsed[found.flag.slice(2) as "repo" | "base" | "head"] = value;
  }
  if (extras.length > 0) return usageError(`unrecognized arguments: ${extras.join(" ")}`);
  return parsed;
}

function scanTree(root: string, base: string, head: string | undefined): { signals: Signal[]; summary: Summary } {
  const summary: Summary = { repos: 0, scanned: 0, changed: 0, unscanned: [], blocked: [] };
  const start = resolveStart(root, base, head);
  if (start === null) {
    summary.blocked.push(".");
    return { signals: [], summary };
  }
  const signals = scanRepo(root, ".", [start, head ?? null], base, summary);
  if (summary.changed > DIFF_LINE_SIGNAL) {
    signals.push(signal(SIZE, "(diff)", `${summary.changed} changed lines excluding tests and generated files > ${DIFF_LINE_SIGNAL}`));
  }
  return { signals, summary };
}

function resolveStart(root: string, base: string, head: string | undefined): string | null {
  if (head && git(root, "cat-file", "-t", head) === "tree") return git(root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  return git(root, "merge-base", base, head || "HEAD");
}

function scanRepo(repo: string, rel: string, span: Span, base: string, summary: Summary): Signal[] {
  const [start, end] = span;
  const changes = readChanges(repo, start, end);
  if (changes === null) {
    summary.blocked.push(rel);
    return [];
  }
  summary.repos += 1;
  const found: Signal[] = [];
  const all = [...changes];
  if (end === null) {
    const { files, nestedRepos } = readUntracked(repo);
    all.push(...files);
    summary.unscanned.push(...nestedRepos.map((path) => `${joinRel(rel, path)}(untracked repo)`));
  }
  for (const [path, beforePath, added, removed] of all) {
    const label = joinRel(rel, path);
    summary.scanned += added.length;
    summary.changed += countReviewableChanges(path, added, removed);
    found.push(...checkLines(label, path, added), ...checkFileSize(repo, span, label, path, beforePath));
  }
  for (const [path, status] of changedGitlinks(repo, start, end)) {
    found.push(...scanSubmodule(repo, joinRel(rel, path), path, status, span, base, summary));
  }
  return found;
}

function joinRel(rel: string, path: string): string {
  return rel === "." ? path : `${rel}/${path}`;
}

function scanSubmodule(parent: string, rel: string, path: string, status: string, parentSpan: Span, base: string, summary: Summary): Signal[] {
  if (status === "A" || status === "D") {
    summary.unscanned.push(`${rel}(${status === "A" ? "added" : "removed"})`);
    return [];
  }
  const span = status === "M" ? resolveSubmoduleSpan(parent, path, parentSpan, base) : BLOCKED;
  if (span === BLOCKED) {
    summary.blocked.push(rel);
    return [];
  }
  return scanRepo(join(parent, path), rel, span, base, summary);
}

function resolveSubmoduleSpan(parent: string, path: string, parentSpan: Span, base: string): Span | typeof BLOCKED {
  const sub = join(parent, path);
  if (!isInitialized(sub)) return BLOCKED;
  const [parentStart, parentEnd] = parentSpan;
  if (parentEnd) {
    const start = readGitlink(parent, parentStart, path);
    const end = readGitlink(parent, parentEnd, path);
    return hasCommit(sub, start) && hasCommit(sub, end) ? [start as string, end as string] : BLOCKED;
  }
  if (namesParentCommit(base, sub)) {
    const start = readGitlink(parent, parentStart, path);
    return hasCommit(sub, start) ? [start as string, null] : BLOCKED;
  }
  const start = git(sub, "merge-base", base, "HEAD");
  return start ? [start, null] : BLOCKED;
}

function namesParentCommit(base: string, sub: string): boolean {
  return HEAD_RELATIVE.test(base) || (FOREIGN_SHA.test(base) && !hasCommit(sub, base));
}

function changedGitlinks(repo: string, start: string, end: string | null): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const raw = git(repo, "diff", "--raw", "--no-renames", "--ignore-submodules=none", start, ...(end ? [end] : []));
  for (const line of splitlines(raw ?? "")) {
    const cut = line.indexOf("\t");
    const meta = cut < 0 ? line : line.slice(0, cut);
    const path = cut < 0 ? "" : line.slice(cut + 1);
    const [oldMode, newMode] = meta.slice(1).split(" ");
    if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) found.push([path, gitlinkStatus(oldMode ?? "", newMode ?? "")]);
  }
  return found;
}

function gitlinkStatus(oldMode: string, newMode: string): string {
  if (oldMode === newMode) return "M";
  if (oldMode !== GITLINK_MODE) return "A";
  return newMode === NO_ENTRY_MODE ? "D" : "T";
}

function isInitialized(sub: string): boolean {
  const top = git(sub, "rev-parse", "--show-toplevel");
  return top !== null && realpathOrSelf(top) === realpathOrSelf(sub);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === undefined) throw error;
    return path;
  }
}

function readGitlink(parent: string, rev: string, path: string): string | null {
  const entry = git(parent, "ls-tree", rev, "--", path) ?? "";
  return new RegExp(`^${GITLINK_MODE} commit ([0-9a-f]+)\t`).exec(entry)?.[1] ?? null;
}

function hasCommit(repo: string, sha: string | null): boolean {
  return !!sha && git(repo, "cat-file", "-e", `${sha}^{commit}`) !== null;
}

function readChanges(repo: string, start: string, end: string | null): Change[] | null {
  const diff = git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--ignore-submodules=all",
    "--src-prefix=a/", "--dst-prefix=b/", start, ...(end ? [end] : []));
  return diff === null ? null : parseUnifiedDiff(diff);
}

function readUntracked(repo: string): { files: Change[]; nestedRepos: string[] } {
  const files: Change[] = [];
  const nestedRepos: string[] = [];
  for (const path of (git(repo, "ls-files", "-z", "--others", "--exclude-standard") ?? "").split("\0").filter((item) => item !== "")) {
    const full = join(repo, path);
    if (path.endsWith("/")) nestedRepos.push(path.replace(/\/+$/, ""));
    else if (isRegularFile(full) && !isBinary(full)) {
      files.push([path, path, splitlines(readText(full)).map((text, index) => [index + 1, text] as const), 0]);
    }
  }
  return { files, nestedRepos };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile() && !lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === undefined) throw error;
    return false;
  }
}

function isBinary(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
    const count = readSync(descriptor, buffer, 0, BINARY_PROBE_BYTES, 0);
    return buffer.subarray(0, count).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

interface DiffEntry {
  path: string | null;
  before: string | null;
  added: Array<readonly [number, string]>;
  removed: number;
}

function parseUnifiedDiff(diff: string): Change[] {
  const changes: Change[] = [];
  let entry: DiffEntry | null = null;
  let lineNumber = 0;
  let inHunk = false;
  const finish = (): void => {
    if (entry?.path) changes.push([entry.path, entry.before || entry.path, entry.added, entry.removed]);
  };
  for (const line of splitlines(diff)) {
    if (line.startsWith("diff --git ")) {
      finish();
      entry = { path: null, before: null, added: [], removed: 0 };
      inHunk = false;
    } else if (entry === null) {
      continue;
    } else if (!inHunk && line.startsWith("--- ")) {
      entry.before = headerPath(line);
    } else if (!inHunk && line.startsWith("+++ ")) {
      entry.path = headerPath(line) || entry.before;
    } else if (line.startsWith("@@")) {
      inHunk = true;
      lineNumber = Number((HUNK_HEADER.exec(line) as RegExpExecArray)[1]);
    } else if (inHunk && line.startsWith("+")) {
      entry.added.push([lineNumber, line.slice(1)]);
      lineNumber += 1;
    } else if (inHunk && line.startsWith("-")) {
      entry.removed += 1;
    }
  }
  finish();
  return changes;
}

function headerPath(line: string): string | null {
  const raw = line.slice(4).replace(/\t+$/, "");
  if (raw === "/dev/null") return null;
  const unquoted = raw.startsWith('"') ? unescapeCString(Array.from(raw).slice(1, -1).join("")) : raw;
  return Array.from(unquoted).slice(2).join("");
}

const SIMPLE_ESCAPES: Record<string, number> = { "\\": 0x5c, "'": 0x27, '"': 0x22, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

function unescapeCString(quoted: string): string {
  const input = Buffer.from(quoted, "utf8");
  const output: number[] = [];
  let index = 0;
  while (index < input.length) {
    const byte = input[index] ?? 0;
    index += 1;
    if (byte !== 0x5c) {
      output.push(byte);
      continue;
    }
    const next = input[index];
    if (next === undefined) throw new RuntimeError("Trailing \\ in string");
    const letter = String.fromCharCode(next);
    index += 1;
    if (letter === "\n") continue;
    if (Object.hasOwn(SIMPLE_ESCAPES, letter)) {
      output.push(SIMPLE_ESCAPES[letter] as number);
    } else if (letter >= "0" && letter <= "7") {
      let digits = letter;
      while (digits.length < 3 && index < input.length && String.fromCharCode(input[index] ?? 0) >= "0" && String.fromCharCode(input[index] ?? 0) <= "7") {
        digits += String.fromCharCode(input[index] ?? 0);
        index += 1;
      }
      output.push(parseInt(digits, 8) & 0xff);
    } else if (letter === "x") {
      const digits = input.subarray(index, index + 2).toString("latin1");
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) throw new RuntimeError(`invalid \\x escape at position ${index - 2}`);
      output.push(parseInt(digits, 16));
      index += 2;
    } else {
      output.push(0x5c, next);
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(output));
}

function countReviewableChanges(path: string, added: Added, removed: number): number {
  if (isTestPath(path) || GENERATED_PATH.test(path)) return 0;
  return added.length + removed;
}

function checkLines(label: string, path: string, added: Added): Signal[] {
  if (isTestPath(path)) return [];
  return added.flatMap(([lineNumber, text]) =>
    matchingChecks(path, text).map((checkId) => signal(checkId, `${label}:${lineNumber}`, pythonStrip(text))));
}

function matchingChecks(path: string, text: string): string[] {
  const ids: string[] = [];
  const isTs = TS_EXT.some((extension) => path.endsWith(extension));
  const isJava = path.endsWith(".java");
  if (isTs && ANY_TYPE.test(text)) ids.push(TYPES);
  if (isTs && text.includes("JSON.parse(") && !API_LAYER_PATH.test(foldDottedAndDotlessI(path))) ids.push(TYPES);
  if (isJava && MAP_OBJECT.test(text)) ids.push(TYPES);
  if (isTs && TS_SUPPRESSION.test(text)) ids.push(TYPES);
  if (isJava && UNCHECKED_SUPPRESSION.test(text)) ids.push(TYPES);
  if (REACT_EXT.some((extension) => path.endsWith(extension)) && EXHAUSTIVE_DEPS_DISABLE.test(text)) ids.push(HIDDEN_BEHAVIOR);
  if ((isTs || isJava) && isSwallowedError(text)) ids.push(ERRORS);
  if (CODE_EXT.some((extension) => path.endsWith(extension)) && COMMENT_LINE.test(text) && isCommentViolation(text)) ids.push(COMMENTS);
  if ((isTs && TS_DECL.test(text)) || (isJava && JAVA_DECL.test(text))) ids.push(NAMES);
  return ids;
}

function isSwallowedError(text: string): boolean {
  return EMPTY_CATCH.test(text) || MESSAGE_ONLY_LOG.test(text);
}

function isCommentViolation(text: string): boolean {
  const ticketlessTodo = TODO.test(text) && !TICKET.test(text);
  return HISTORY_COMMENT.test(foldDottedAndDotlessI(text)) || ticketlessTodo || BANNER.test(text);
}

function checkFileSize(repo: string, span: Span, label: string, path: string, beforePath: string): Signal[] {
  if (isTestPath(path)) return [];
  let limits: Array<["lines" | "useState", number]>;
  if (path.endsWith(".tsx")) limits = [["lines", COMPONENT_LINE_SIGNAL], ["useState", USE_STATE_SIGNAL]];
  else if (path.endsWith(".java")) limits = [["lines", CLASS_LINE_SIGNAL]];
  else return [];
  const [start, end] = span;
  const before = git(repo, "show", `${start}:${beforePath}`) || "";
  const after = (end ? git(repo, "show", `${end}:${path}`) : readText(join(repo, path))) || "";
  const found: Signal[] = [];
  for (const [measure, limit] of limits) {
    const oldSize = measureFile(before, measure);
    const newSize = measureFile(after, measure);
    if (newSize > limit && limit >= oldSize) found.push(signal(SIZE, label, `${measure} ${oldSize} → ${newSize} > ${limit}`));
  }
  return found;
}

function fnmatchcase(name: string, pattern: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "su").test(name);
}

function isTestPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))) return true;
  return TEST_BASENAME_GLOBS.some((glob) => fnmatchcase(segments[segments.length - 1] as string, glob));
}

function measureFile(text: string, measure: "lines" | "useState"): number {
  return measure === "lines" ? splitlines(text).length : (text.match(USE_STATE) ?? []).length;
}

function signal(checkId: string, where: string, text: string): Signal {
  return { id: checkId, where, text: truncate(text, SIGNAL_TEXT_LIMIT) };
}

function formatSummary(summary: Summary, signalCount: number): string {
  const unscanned = summary.unscanned.join(",") || "none";
  const blocked = summary.blocked.join(",") || "none";
  return `summary repos=${summary.repos} scanned_lines=${summary.scanned} signals=${signalCount} unscanned=${unscanned} blocked=${blocked}`;
}

function git(repo: string, ...args: string[]): string | null {
  const completed = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: UNLIMITED_OUTPUT_BYTES });
  if (completed.error) throw completed.error;
  return completed.status === 0 ? stripNewlines(completed.stdout.replace(/\r\n?/g, "\n")) : null;
}

function readText(path: string): string {
  try {
    return readFileSync(path).toString("utf8").replace(/\r\n?/g, "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

const LINE_FIXTURES: Record<string, Array<[string, string[]]>> = {
  "web/Screen.tsx": [
    ["const a: any = 1", [TYPES]], ["const c = x as any", [TYPES]], ["const d = <any>y", [TYPES]],
    ["const b = JSON.parse(s)", [TYPES]], ["const data = load()", [NAMES]],
    ["const rows: Row[] = []", []], ["{count > 0 && <Badge />}", []],
    ["// @ts-ignore", [TYPES]], ["/// @ts-ignore", [TYPES]], ["// @ts-expect-error: legacy prop", [TYPES]],
    ["{/* @ts-ignore */}", [TYPES]], ["// never add @ts-ignore here", []], ["const tag = '@ts-ignore'", []],
    ["// eslint-disable-next-line react-hooks/exhaustive-deps", [HIDDEN_BEHAVIOR]],
    ["}, []) // eslint-disable-line react-hooks/exhaustive-deps", [HIDDEN_BEHAVIOR]],
    ["/* eslint-disable react-hooks/rules-of-hooks, react-hooks/exhaustive-deps */", [HIDDEN_BEHAVIOR]],
    ["// eslint-disable-next-line no-console", []], ["/* eslint-enable react-hooks/exhaustive-deps */", []],
    ["// the exhaustive-deps rule caught a stale closure", []],
  ],
  "web/Panel.jsx": [
    ["{/* eslint-disable-next-line react-hooks/exhaustive-deps */}", [HIDDEN_BEHAVIOR]],
    ["const a = load() // @ts-ignore", []], ["const a: any = 1", []],
  ],
  "web/api/items.ts": [["export const parse = (s: string) => JSON.parse(s) as Item", []]],
  "web/Screen.test.tsx": [["const x: any = 1", []], ["// @ts-ignore", []]],
  "web/log.ts": [['log.error("x {}", e.getMessage())', [ERRORS]], ['log.warn("skip {}", e.getMessage(), e)', []]],
  "core/Service.java": [
    ["Map<String, Object> m = new HashMap<>();", [TYPES]], ["try { run(); } catch (Exception e) {}", [ERRORS]],
    ['log.error("failed {}", e.getMessage());', [ERRORS]], ['log.error("failed order={}", orderId, e);', []],
    ["// this used to call the old API", [COMMENTS]], ["/* no longer used by the batch */", [COMMENTS]],
    [" * corrected after the outage", [COMMENTS]], ["// TODO clean this", [COMMENTS]], ["// ------", [COMMENTS]],
    ["// TODO ABC-123 drop after migration", []], ['String day = "2026-10-07";', []], ["String data = x;", [NAMES]],
    ['@SuppressWarnings("unchecked")', [TYPES]], ['@SuppressWarnings({"unchecked", "rawtypes"})', [TYPES]],
    ['@SuppressWarnings("deprecation")', []],
  ],
  "core/pom.xml": [["<version>${project.version}</version>", []]],
};

function runSelfTest(): number {
  const results = [...checkLineFixtures(), ...checkDiffParser(), ...checkRuleSources(), ...checkCrashContract()];
  const failures = results.filter((result): result is string => result !== null);
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.stdout.write(`self-test: ${results.length - failures.length}/${results.length} pass\n`);
  return failures.length > 0 ? 1 : 0;
}

function checkLineFixtures(): Array<string | null> {
  const results: Array<string | null> = [];
  for (const [path, lines] of Object.entries(LINE_FIXTURES)) {
    lines.forEach(([text, expected], index) => {
      const got = checkLines(path, path, [[index + 1, text]]).map((found) => found.id);
      results.push(expect(JSON.stringify(got) === JSON.stringify(expected), `${path}: ${JSON.stringify(text)} expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`));
    });
  }
  return results;
}

function checkDiffParser(): Array<string | null> {
  const diff = "diff --git a/web/Gone.ts b/web/Gone.ts\ndeleted file mode 100644\n--- a/web/Gone.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n" +
    "diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n--- a/not a header\n+--- not a header\n" +
    "diff --git a/old/X.java b/new/X.java\nsimilarity index 90%\nrename from old/X.java\nrename to new/X.java\n--- a/old/X.java\n+++ b/new/X.java\n@@ -1,0 +2 @@\n+y\n" +
    "diff --git a/old/Y.java b/new/Y.java\nsimilarity index 100%\nrename from old/Y.java\nrename to new/Y.java\n" +
    'diff --git "a/q\\"x.ts" "b/q\\"x.ts"\n--- "a/q\\"x.ts"\n+++ "b/q\\"x.ts"\n@@ -0,0 +1 @@\n+z\n';
  const got = JSON.stringify(parseUnifiedDiff(diff));
  const expected = JSON.stringify([["web/Gone.ts", "web/Gone.ts", [], 3], ["my file.ts", "my file.ts", [[1, "--- not a header"]], 1],
    ["new/X.java", "old/X.java", [[2, "y"]], 0], ['q"x.ts', 'q"x.ts', [[1, "z"]], 0]]);
  return [expect(got === expected, `diff parser (deleted, spaced path, "---" content, edited and pure rename, C-quoted name): got ${got}`)];
}

function checkRuleSources(): Array<string | null> {
  const rulesPath = join(SKILL_DIR, "references", "rules.md");
  const skill = existsSync(rulesPath) ? readText(rulesPath) : "";
  const pinned = ["`" + BANNED_NAMES.replaceAll("|", ", ") + "`", `class ${CLASS_LINE_SIGNAL}`, `FE component ${COMPONENT_LINE_SIGNAL}`,
    `\`useState\` per component ${USE_STATE_SIGNAL}`, `**${DIFF_LINE_SIGNAL} changed lines**`,
    "`@ts-ignore`", "`@ts-expect-error`", '`@SuppressWarnings("unchecked")`', "a disabled `react-hooks/exhaustive-deps`"];
  const missing = pinned.filter((item) => !skill.includes(item));
  return [expect(missing.length === 0, `readable-code references/rules.md no longer states ${JSON.stringify(missing)}: update the constants`)];
}

function checkCrashContract(): Array<string | null> {
  const chunks: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let code: number;
  try {
    code = runCli(["--repo", "/x", "--base", "b"], () => { throw new RuntimeError("boom"); });
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }
  const last = chunks.join("").trim().split("\n").pop() ?? "";
  return [expect(code === 2 && last.endsWith("blocked=.(crashed: RuntimeError)"), `crash contract: got exit ${code}, ${JSON.stringify(last)}`)];
}

function expect(ok: boolean, message: string): string | null {
  return ok ? null : message;
}

if (import.meta.main) main();

export { API_LAYER_PATH, TEST_BASENAME_GLOBS, TEST_SEGMENTS, foldDottedAndDotlessI, isTestPath, runCli };
