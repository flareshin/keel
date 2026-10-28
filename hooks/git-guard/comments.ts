import { extname } from "node:path";
import { splitlines, trimSpace } from "../lib/hookkit/text.ts";

const SLASH_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".java", ".kt", ".kts", ".groovy", ".scala",
  ".go", ".rs", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".dart", ".css", ".scss", ".less",
]);
const HASH_EXTENSIONS: ReadonlySet<string> = new Set([".sh", ".bash", ".zsh", ".rb", ".pl"]);
const PYTHON_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".pyi"]);
const SQL_EXTENSIONS: ReadonlySet<string> = new Set([".sql"]);
const BLOCK_OPEN = "/*";
const BLOCK_CLOSE = "*/";
const TRIPLE_QUOTE = /"""|'''/gu;
const DOCSTRING_OPENER = /^[rRuUbB]?("""|''')/u;
const SHEBANG = "#!";
const COMMENT_MARKERS = /^(\/\*+|\/+|\*+\/?|#+|--+|[rRuUbB]?"""|[rRuUbB]?''')\s*/u;
const ALLOWED_BODY = new RegExp("^(" + [
  "eslint", "global ", "prettier-ignore", "biome-ignore", "@ts-", "istanbul ", "c8 ", "jshint", "tslint", "#__PURE__",
  "<reference ", "noqa", "type: ?ignore", "pylint:", "pyright:", "mypy:", "fmt: ?(off|on|skip)", "isort:", "-\\*- coding",
  "(vim?: ?)?(file)?coding[:=]", "pragma", "nolint", "go:", "\\+build", "shellcheck ", "NOSONAR", "CHECKSTYLE", "noinspection",
  "language=", "SPDX-License-Identifier:", "Copyright( \\(c\\)| ©| [0-9]{4})", "\\(c\\) [0-9]{4}", "© ?[0-9]{4}",
].join("|") + ")", "u");

type CommentFinder = (text: string) => string[];

export function addedComments(path: string, before: string, after: string): string[] {
  const findComments = commentFinderOf(path);
  if (findComments === null) return [];
  const remaining = new Map<string, number>();
  for (const line of reported(findComments(before))) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of reported(findComments(after))) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added.push(line);
  }
  return added;
}

function commentFinderOf(path: string): CommentFinder | null {
  const extension = extname(path).toLowerCase();
  if (SLASH_EXTENSIONS.has(extension)) return slashComments;
  if (HASH_EXTENSIONS.has(extension)) return (text) => lineComments(text, "#");
  if (PYTHON_EXTENSIONS.has(extension)) return pythonComments;
  if (SQL_EXTENSIONS.has(extension)) return (text) => lineComments(text, "--");
  return null;
}

function slashComments(text: string): string[] {
  const lines = trimmedLines(text);
  let isInsideBlock = false;
  const found: string[] = [];
  for (const line of lines) {
    if (isInsideBlock || line.startsWith(BLOCK_OPEN)) {
      found.push(line);
      const closeFrom: number = isInsideBlock ? 0 : BLOCK_OPEN.length;
      isInsideBlock = !line.includes(BLOCK_CLOSE, closeFrom);
    } else if (line.startsWith("//")) {
      found.push(line);
    }
  }
  return found;
}

function pythonComments(text: string): string[] {
  const found: string[] = [];
  let openString: "docstring" | "data" | null = null;
  let previousCode: string | null = null;
  for (const line of trimmedLines(text)) {
    const quoteCount = line.match(TRIPLE_QUOTE)?.length ?? 0;
    if (openString === null) {
      const isDocstring = DOCSTRING_OPENER.test(line) && (previousCode === null || previousCode.endsWith(":"));
      if (line.startsWith("#") || isDocstring) found.push(line);
      if (quoteCount % 2 === 1) openString = isDocstring ? "docstring" : "data";
      if (line !== "" && !line.startsWith("#")) previousCode = line;
    } else {
      if (openString === "docstring") found.push(line);
      if (quoteCount % 2 === 1) openString = null;
    }
  }
  return found;
}

function lineComments(text: string, marker: string): string[] {
  return trimmedLines(text).filter((line) => line.startsWith(marker));
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
