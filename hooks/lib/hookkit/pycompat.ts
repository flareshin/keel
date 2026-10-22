/** Python string, path and JSON behaviors the hookkit port must reproduce exactly (DESIGN: hooks are ported 1:1). */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

/** The characters `str.isspace()` and the `\s` of a Python `str` pattern accept, as a regex character-class body. */
export const PY_SPACE = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
/** What `\w` matches in a Python `str` pattern, as a regex character-class body for the `u` flag. */
export const PY_WORD = String.raw`\p{L}\p{N}_`;

const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);
const SPLITLINES_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const UNIVERSAL_NEWLINE = /\r\n|[\r\n]/;
const ENVIRONMENT_VARIABLE = /\$([A-Za-z0-9_]+|\{[^}]*\})/g;
// Numeric_Type=Digit characters outside Nd, which `str.isdigit()` accepts: superscripts, circled digits, ...
const NON_DECIMAL_DIGITS = String.raw`\u00b2\u00b3\u00b9\u1369-\u1371\u19da\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468` +
  String.raw`\u2474-\u247c\u2488-\u2490\u24ea\u24f5-\u24fd\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792` +
  String.raw`\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}`;
const DIGITS = new RegExp(`^[\\p{Nd}${NON_DECIMAL_DIGITS}]+$`, "u");

export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `dict.get(key)`: the own value, or null when the key is absent. */
export function getField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : null;
}

export function hasField(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** `text[:count]`, counted in code points; a negative count drops that many from the end. */
export function truncate(text: string, count: number): string {
  if (count >= 0 && text.length <= count) return text;
  const characters = Array.from(text);
  const end = count < 0 ? Math.max(characters.length + count, 0) : count;
  return characters.slice(0, end).join("");
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function sortedByCodePoint(items: Iterable<string>): string[] {
  return Array.from(items).sort(compareCodePoints);
}

/** `str.splitlines()`: every Unicode line break, no trailing empty element. */
export function splitlines(text: string): string[] {
  const lines = text.split(SPLITLINES_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The lines `for line in open(path)` yields in text mode, without their newline: `\r\n`, `\r` and `\n` only. */
export function fileLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(UNIVERSAL_NEWLINE);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `str.strip()` with no argument. */
export function strip(text: string): string {
  return text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

/** `str.strip(chars)`. */
export function stripChars(text: string, chars: string): string {
  const characters = Array.from(text);
  let start = 0;
  let end = characters.length;
  while (start < end && chars.includes(characters[start] ?? "")) start += 1;
  while (end > start && chars.includes(characters[end - 1] ?? "")) end -= 1;
  return characters.slice(start, end).join("");
}

export function rstripChar(text: string, character: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === character) end -= 1;
  return text.slice(0, end);
}

export function lstripChar(text: string, character: string): string {
  let start = 0;
  while (start < text.length && text[start] === character) start += 1;
  return text.slice(start);
}

/** `str.partition(separator)` as [head, separator or "", tail]. */
export function partition(text: string, separator: string): [string, string, string] {
  const index = text.indexOf(separator);
  if (index < 0) return [text, "", ""];
  return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

/** `str.isdigit()`. */
export function isDigits(text: string): boolean {
  return DIGITS.test(text);
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** `os.path.basename`: everything after the last slash, so a trailing slash gives "". */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `os.path.join`: an absolute part restarts the path. */
export function joinPath(first: string, ...rest: string[]): string {
  let path = first;
  for (const part of rest) {
    if (part.startsWith("/")) path = part;
    else if (path === "" || path.endsWith("/")) path += part;
    else path += "/" + part;
  }
  return path;
}

/** `os.path.normpath`: drops a trailing slash and keeps exactly two leading slashes. */
export function normalizePath(path: string): string {
  if (path === "") return ".";
  const leadingSlashes = path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? "/" : "";
  const kept: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== ".." || (leadingSlashes === "" && kept.length === 0) || kept[kept.length - 1] === "..") kept.push(part);
    else if (kept.length > 0) kept.pop();
  }
  return leadingSlashes + kept.join("/") || ".";
}

function passwdHome(name: string): string | null {
  try {
    const current = userInfo();
    if (current.username === name) return current.homedir;
  } catch {
    // fall through to the passwd file
  }
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields[0] === name && fields.length >= 6) return fields[5] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/** `os.path.expanduser`: `~` from HOME at call time, `~name` from the account database. */
export function expandUser(path: string): string {
  if (!path.startsWith("~")) return path;
  const slash = path.indexOf("/", 1);
  const end = slash < 0 ? path.length : slash;
  let home: string | null;
  if (end === 1) {
    if (Object.hasOwn(process.env, "HOME")) home = process.env["HOME"] ?? "";
    else {
      try {
        home = userInfo().homedir;
      } catch {
        return path;
      }
    }
  } else {
    home = passwdHome(path.slice(1, end));
    if (home === null) return path;
  }
  return rstripChar(home, "/") + path.slice(end) || "/";
}

/** `os.path.expandvars`: `$NAME` and `${NAME}` (ASCII names) that the environment defines; others stay as written. */
export function expandVars(path: string): string {
  if (!path.includes("$")) return path;
  return path.replace(ENVIRONMENT_VARIABLE, (whole, name: string) => {
    const variable = name.startsWith("{") ? name.slice(1, -1) : name;
    return Object.hasOwn(process.env, variable) ? (process.env[variable] ?? whole) : whole;
  });
}

function pythonRepr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    return quote + (quote === "'" ? escaped.replaceAll("'", "\\'") : escaped) + quote;
  }
  return pythonStr(value);
}

/** `str(value)` for the JSON values a hook payload holds. */
export function pythonStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return "[" + value.map(pythonRepr).join(", ") + "]";
  if (isRecord(value)) return "{" + Object.entries(value).map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`).join(", ") + "}";
  return String(value);
}

/** `json.dumps(value, ensure_ascii=False)`: `", "` and `": "` separators, non-ASCII text kept as written. */
export function pythonJsonDumps(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((item) => pythonJsonDumps(item === undefined ? null : item)).join(", ") + "]";
  if (isRecord(value)) {
    const members = Object.entries(value).filter(([, item]) => item !== undefined);
    return "{" + members.map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`).join(", ") + "}";
  }
  return JSON.stringify(value);
}
