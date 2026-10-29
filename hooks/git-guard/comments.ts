import { extname } from "node:path";
import { splitlines, trimSpace } from "../lib/hookkit/text.ts";

const SLASH_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".java", ".groovy",
  ".go", ".rs", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".dart",
]);
const RAW_TEXT_BLOCK_EXTENSIONS: ReadonlySet<string> = new Set([".kt", ".kts", ".scala"]);
const STYLE_EXTENSIONS: ReadonlySet<string> = new Set([".css", ".scss", ".less"]);
const SHELL_EXTENSIONS: ReadonlySet<string> = new Set([".sh", ".bash", ".zsh"]);
const SCRIPT_HASH_EXTENSIONS: ReadonlySet<string> = new Set([".rb", ".pl"]);
const PYTHON_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".pyi"]);
const SQL_EXTENSIONS: ReadonlySet<string> = new Set([".sql"]);
const BLOCK_OPEN = "/*";
const BLOCK_CLOSE = "*/";
const TRIPLE_QUOTE = /"""|'''/gu;
const DOCSTRING_OPENER = /^[rRuUbB]?("""|''')/u;
const SHEBANG = "#!";
const WORD_BREAK = /[\s;|&()]/u;
const HERE_STRING = "<<<";
const ARITHMETIC_OPEN = "((";
const ARITHMETIC_CLOSE = "))";
const REGEX_PRECEDERS: ReadonlySet<string> = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS: ReadonlySet<string> = new Set(["return", "typeof", "case", "yield", "await", "in", "of", "else", "void", "delete", "throw", "new", "instanceof", "do"]);
const TRAILING_WORD = /[A-Za-z_$][\w$]*$/u;
const TEXT_BLOCK_QUOTES: readonly string[] = ['"""', "'''"];
const COMMENT_MARKERS = /^(\/\*+|\/+|\*+\/?|#+|--+|[rRuUbB]?"""|[rRuUbB]?''')\s*/u;
const ALLOWED_BODY = new RegExp("^(" + [
  "eslint", "global ", "prettier-ignore", "biome-ignore", "@ts-", "istanbul ", "c8 ", "jshint", "tslint", "#__PURE__",
  "<reference ", "noqa", "type: ?ignore", "pylint:", "pyright:", "mypy:", "fmt: ?(off|on|skip)", "isort:", "-\\*- coding",
  "(vim?: ?)?(file)?(en)?coding[:=]", "pragma", "nolint", "go:", "\\+build", "shellcheck ", "NOSONAR", "CHECKSTYLE", "noinspection",
  "language=", "SPDX-License-Identifier:", "Copyright( \\(c\\)| ©| [0-9]{4})", "\\(c\\) [0-9]{4}", "© ?[0-9]{4}",
  "frozen_string_literal:", "rubocop:", "@jsx ", "@jsxImportSource", "@jsxRuntime", "@vitest-environment", "@jest-environment",
  "NOLINT", "NOLINTNEXTLINE", "NOLINTBEGIN", "NOLINTEND", "liquibase formatted sql", "changeset ", "webpack[A-Z][A-Za-z]*:", "swiftlint:",
  "rollback ", "comment:", "preconditions ", "precondition-", "ruff:", "clang-format ", "yapf:", "@flow", "deno-lint-ignore",
].map(wholeWord).join("|") + ")", "u");

function wholeWord(directive: string): string {
  return /[A-Za-z]$/u.test(directive) ? `${directive}(?![A-Za-z])` : directive;
}

type CommentFinder = (text: string) => string[];
type SpanContent = "comment" | "string" | "heredoc";
type Span = { content: SpanContent; closes: (line: string) => boolean };
type LineScan = { comments: string[]; open: Span | null };
type SlashDialect = { isStyleSheet: boolean; textBlockEscapes: boolean };
type HashDialect = { heredoc: RegExp; singleQuoteEscapes: boolean };

const BLOCK_SPAN: Span = { content: "comment", closes: (line) => line.includes(BLOCK_CLOSE) };
const CODE: SlashDialect = { isStyleSheet: false, textBlockEscapes: true };
const RAW_TEXT_BLOCKS: SlashDialect = { isStyleSheet: false, textBlockEscapes: false };
const STYLE_SHEET: SlashDialect = { isStyleSheet: true, textBlockEscapes: true };
const SHELL: HashDialect = { heredoc: /^<<-?[ \t]*\\?(['"]?)([A-Za-z_]\w*)\1/u, singleQuoteEscapes: false };
const SCRIPT: HashDialect = { heredoc: /^<<[-~]?(['"]?)([A-Za-z_]\w*)\1/u, singleQuoteEscapes: true };

export function addedComments(path: string, before: string, after: string): string[] {
  const findComments = commentFinderOf(path);
  if (findComments === null) return [];
  const remaining = new Map<string, number>();
  for (const line of reported(findComments(before))) {
    const key = withStraightQuotes(line);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of reported(findComments(after))) {
    const key = withStraightQuotes(line);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else added.push(line);
  }
  return added;
}

export function withStraightQuotes(text: string): string {
  return text.replace(/[\u2018\u2019]/gu, "'").replace(/[\u201C\u201D]/gu, '"');
}

function commentFinderOf(path: string): CommentFinder | null {
  const extension = extname(path).toLowerCase();
  if (SLASH_EXTENSIONS.has(extension)) return (text) => scannedComments(text, (line) => scanSlashLine(line, CODE));
  if (RAW_TEXT_BLOCK_EXTENSIONS.has(extension)) return (text) => scannedComments(text, (line) => scanSlashLine(line, RAW_TEXT_BLOCKS));
  if (STYLE_EXTENSIONS.has(extension)) return (text) => scannedComments(text, (line) => scanSlashLine(line, STYLE_SHEET));
  if (SHELL_EXTENSIONS.has(extension)) return (text) => scannedComments(text, (line) => scanHashLine(line, SHELL));
  if (SCRIPT_HASH_EXTENSIONS.has(extension)) return (text) => scannedComments(text, (line) => scanHashLine(line, SCRIPT));
  if (PYTHON_EXTENSIONS.has(extension)) return pythonComments;
  if (SQL_EXTENSIONS.has(extension)) return (text) => scannedComments(text, (line) => scanMarkerLine(line, "--", false));
  return null;
}

function scannedComments(text: string, scanLine: (line: string) => LineScan): string[] {
  const found: string[] = [];
  let open: Span | null = null;
  for (const line of trimmedLines(text)) {
    if (open !== null) {
      if (open.content === "comment") found.push(line);
      if (open.content === "string" && scanLine(line).comments[0] === line) found.push(line);
      if (open.closes(line)) open = null;
    } else {
      const scan = scanLine(line);
      found.push(...scan.comments);
      open = scan.open;
    }
  }
  return found;
}

function scanSlashLine(line: string, dialect: SlashDialect): LineScan {
  const { isStyleSheet } = dialect;
  const comments: string[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    const next = line.charAt(index + 1);
    if (char === '"' || char === "'" || (char === "`" && !isStyleSheet)) {
      const quote = TEXT_BLOCK_QUOTES.find((opener) => line.startsWith(opener, index)) ?? char;
      const isVerbatim = char === '"' && line.charAt(index - 1) === "@";
      const hasEscapes = quote.length === 1 ? !isVerbatim : dialect.textBlockEscapes;
      const close = closingIndex(line, index + quote.length, quote, hasEscapes);
      if (close === -1) return { comments, open: quote === "'" || quote === '"' ? null : stringSpan(quote, hasEscapes) };
      index = close + quote.length;
    } else if (char === "/" && next === "*") {
      const close = line.indexOf(BLOCK_CLOSE, index + BLOCK_OPEN.length);
      if (close === -1) return { comments: [...comments, line.slice(index)], open: BLOCK_SPAN };
      comments.push(line.slice(index, close + BLOCK_CLOSE.length));
      index = close + BLOCK_CLOSE.length;
    } else if (char === "/" && next === "/" && !isStyleSheet) {
      return { comments: [...comments, line.slice(index)], open: null };
    } else if (char === "/" && !isStyleSheet && opensRegex(line.slice(0, index).trimEnd())) {
      const close = closingRegex(line, index);
      if (close === -1) return { comments, open: null };
      index = close + 1;
    } else {
      index += 1;
    }
  }
  return { comments, open: null };
}

function opensRegex(before: string): boolean {
  const previous = before.charAt(before.length - 1);
  return previous === "" || REGEX_PRECEDERS.has(previous) || REGEX_KEYWORDS.has(TRAILING_WORD.exec(before)?.[0] ?? "");
}

function closingRegex(line: string, start: number): number {
  let isInsideClass = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (char === "\\") index += 1;
    else if (char === "[") isInsideClass = true;
    else if (char === "]") isInsideClass = false;
    else if (char === "/" && !isInsideClass) return index;
  }
  return -1;
}

function closingIndex(line: string, from: number, closer: string, hasEscapes: boolean): number {
  for (let index = from; index < line.length; index += 1) {
    if (hasEscapes && line.charAt(index) === "\\") index += 1;
    else if (line.startsWith(closer, index)) return index;
  }
  return -1;
}

function stringSpan(closer: string, hasEscapes: boolean): Span {
  return { content: "string", closes: (line) => closingIndex(line, 0, closer, hasEscapes) !== -1 };
}

function scanHashLine(line: string, dialect: HashDialect): LineScan {
  let open: Span | null = null;
  let arithmeticDepth = 0;
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '"' || char === "'") {
      const hasEscapes = char === '"' || dialect.singleQuoteEscapes;
      const close = closingIndex(line, index + 1, char, hasEscapes);
      if (close === -1) return { comments: [], open: stringSpan(char, hasEscapes) };
      index = close + 1;
    } else if (char === "#" && (index === 0 || WORD_BREAK.test(line.charAt(index - 1)))) {
      return { comments: [line.slice(index)], open };
    } else if (line.startsWith(HERE_STRING, index)) {
      index += HERE_STRING.length;
    } else if (line.startsWith(ARITHMETIC_OPEN, index)) {
      arithmeticDepth += 1;
      index += ARITHMETIC_OPEN.length;
    } else if (line.startsWith(ARITHMETIC_CLOSE, index) && arithmeticDepth > 0) {
      arithmeticDepth -= 1;
      index += ARITHMETIC_CLOSE.length;
    } else {
      const heredoc = char === "<" && arithmeticDepth === 0 ? dialect.heredoc.exec(line.slice(index)) : null;
      if (heredoc !== null) {
        const delimiter = heredoc[2];
        open = { content: "heredoc", closes: (body) => body === delimiter };
        index += heredoc[0].length;
      } else {
        index += 1;
      }
    }
  }
  return { comments: [], open };
}

function pythonComments(text: string): string[] {
  const found: string[] = [];
  let openString: "docstring" | "data" | null = null;
  let previousCode: string | null = null;
  for (const line of trimmedLines(text)) {
    const quoteCount = line.match(TRIPLE_QUOTE)?.length ?? 0;
    if (openString === null) {
      const isDocstring = DOCSTRING_OPENER.test(line) && (previousCode === null || previousCode.endsWith(":"));
      found.push(...(isDocstring ? [line] : scanMarkerLine(line, "#", true).comments));
      if (quoteCount % 2 === 1) openString = isDocstring ? "docstring" : "data";
      if (line !== "" && !line.startsWith("#")) previousCode = line;
    } else {
      if (openString === "docstring") found.push(line);
      if (quoteCount % 2 === 1) openString = null;
    }
  }
  return found;
}

function scanMarkerLine(line: string, marker: string, hasEscapes: boolean): LineScan {
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '"' || char === "'") {
      const close = closingIndex(line, index + 1, char, hasEscapes);
      if (close === -1) return { comments: [], open: stringSpan(char, hasEscapes) };
      index = close + 1;
    } else if (line.startsWith(marker, index)) {
      return { comments: [line.slice(index)], open: null };
    } else {
      index += 1;
    }
  }
  return { comments: [], open: null };
}

function trimmedLines(text: string): string[] {
  return splitlines(text).map(trimSpace);
}

function reported(comments: readonly string[]): string[] {
  return comments.filter((line) => {
    if (line.startsWith(SHEBANG)) return false;
    const body = trimSpace(line.replace(COMMENT_MARKERS, "").replace(/\*\/$|"""$|'''$/u, ""));
    return body !== "" && !ALLOWED_BODY.test(body);
  });
}
