import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { userInfo } from "node:os";
import { OSError, run, TimeoutExpired } from "./subprocess.ts";
import type { CompletedProcess } from "./subprocess.ts";

export const PY_SPACE = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
export const PY_WORD = String.raw`\p{L}\p{N}_`;
export const SPACE_CLASS = `[${PY_SPACE}]`;
export const WORD_CLASS = `[${PY_WORD}]`;
export const WORD_BOUNDARY = `(?:(?<=${WORD_CLASS})(?!${WORD_CLASS})|(?<!${WORD_CLASS})(?=${WORD_CLASS}))`;

const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);
const SPLITLINES_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const UNIVERSAL_NEWLINE = /\r\n|[\r\n]/;
const ENVIRONMENT_VARIABLE = /\$([A-Za-z0-9_]+|\{[^}]*\}?)/g;
const DOTTED_OR_DOTLESS_I = /[İı]/g;
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

export function getField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : null;
}

export function hasField(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function foldDottedAndDotlessI(text: string): string {
  return text.replace(DOTTED_OR_DOTLESS_I, "i");
}

export function testCaseFolded(pattern: RegExp, text: string): boolean {
  return pattern.test(foldDottedAndDotlessI(text));
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

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

export function splitlines(text: string): string[] {
  const lines = text.split(SPLITLINES_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function universalNewlineLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(UNIVERSAL_NEWLINE);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function strip(text: string): string {
  return text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
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

export function partition(text: string, separator: string): [string, string, string] {
  const index = text.indexOf(separator);
  if (index < 0) return [text, "", ""];
  return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

export function isDigits(text: string): boolean {
  return DIGITS.test(text);
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(first: string, ...rest: string[]): string {
  let path = first;
  for (const part of rest) {
    if (part.startsWith("/")) path = part;
    else if (path === "" || path.endsWith("/")) path += part;
    else path += "/" + part;
  }
  return path;
}

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

const GLOB_MAGIC = /[*?[]/;
const CLASS_NEGATION = "!";
const RANGE_HYPHEN = "-";

export function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf("/") + 1;
  const head = path.slice(0, cut);
  return [head === "/".repeat(head.length) ? head : rstripChar(head, "/"), path.slice(cut)];
}

function codePointOf(character: string): number {
  return character.codePointAt(0) ?? 0;
}

function escapedCodePoint(character: string): string {
  return `\\u{${codePointOf(character).toString(16)}}`;
}

function classEnd(characters: readonly string[], start: number): number {
  let end = start;
  if (characters[end] === CLASS_NEGATION) end += 1;
  if (characters[end] === "]") end += 1;
  while (end < characters.length && characters[end] !== "]") end += 1;
  return end >= characters.length ? -1 : end;
}

function hyphenChunks(members: readonly string[]): string[][] {
  if (!members.includes(RANGE_HYPHEN)) return [[...members]];
  const chunks: string[][] = [];
  let chunkStart = 0;
  let search = members[0] === CLASS_NEGATION ? 2 : 1;
  for (;;) {
    const hyphen = members.indexOf(RANGE_HYPHEN, search);
    if (hyphen < 0) break;
    chunks.push(members.slice(chunkStart, hyphen));
    chunkStart = hyphen + 1;
    search = hyphen + 3;
  }
  const last = members.slice(chunkStart);
  if (last.length > 0) chunks.push(last);
  else chunks[chunks.length - 1]?.push(RANGE_HYPHEN);
  for (let index = chunks.length - 1; index > 0; index -= 1) {
    const previous = chunks[index - 1] ?? [];
    const current = chunks[index] ?? [];
    if (codePointOf(previous[previous.length - 1] ?? "") > codePointOf(current[0] ?? "")) {
      chunks[index - 1] = [...previous.slice(0, -1), ...current.slice(1)];
      chunks.splice(index, 1);
    }
  }
  return chunks;
}

function characterClassSource(members: readonly string[]): string {
  const negated = members[0] === CLASS_NEGATION;
  const chunks = hyphenChunks(members);
  if (negated) chunks[0]?.shift();
  const items: string[] = [];
  chunks.forEach((chunk, index) => {
    items.push(...chunk.map(escapedCodePoint));
    const next = chunks[index + 1];
    const start = chunk[chunk.length - 1];
    if (next !== undefined && start !== undefined && next[0] !== undefined) {
      items.push(`${escapedCodePoint(start)}-${escapedCodePoint(next[0])}`);
    }
  });
  if (items.length === 0) return negated ? "." : "(?!)";
  return `[${negated ? "^" : ""}${items.join("")}]`;
}

function fnmatchRegExp(pattern: string): RegExp {
  const characters = Array.from(pattern);
  let source = "";
  let index = 0;
  while (index < characters.length) {
    const character = characters[index] ?? "";
    index += 1;
    if (character === "*") {
      source += ".*";
      while (characters[index] === "*") index += 1;
    } else if (character === "?") {
      source += ".";
    } else if (character === "[") {
      const end = classEnd(characters, index);
      if (end < 0) {
        source += escapedCodePoint(character);
      } else {
        source += characterClassSource(characters.slice(index, end));
        index = end + 1;
      }
    } else {
      source += escapedCodePoint(character);
    }
  }
  return new RegExp(`^(?:${source})$`, "su");
}

function tryStat(path: string, follow: boolean) {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function isDirectoryEntry(parent: string, entry: Dirent): boolean {
  return entry.isSymbolicLink() ? (tryStat(joinPath(parent, entry.name), true)?.isDirectory() ?? false) : entry.isDirectory();
}

function listNames(directory: string, directoriesOnly: boolean): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory === "" ? "." : directory, { withFileTypes: true });
  } catch (error) {
    if (isSystemError(error)) return [];
    throw error;
  }
  return entries.filter((entry) => !directoriesOnly || isDirectoryEntry(directory, entry)).map((entry) => entry.name);
}

function matchingNames(directory: string, pattern: string, directoriesOnly: boolean): string[] {
  const matcher = fnmatchRegExp(pattern);
  const showsHidden = pattern.startsWith(".");
  return listNames(directory, directoriesOnly).filter((name) => (showsHidden || !name.startsWith(".")) && matcher.test(name));
}

function literalName(directory: string, name: string): string[] {
  if (name !== "") return tryStat(joinPath(directory, name), false) === null ? [] : [name];
  return tryStat(directory, true)?.isDirectory() ? [name] : [];
}

function globPath(pathname: string, directoriesOnly: boolean): string[] {
  const [directory, name] = splitPath(pathname);
  if (!GLOB_MAGIC.test(pathname)) return literalName(directory, name).length > 0 ? [pathname] : [];
  if (directory === "") return matchingNames("", name, directoriesOnly);
  const directories = GLOB_MAGIC.test(directory) ? globPath(directory, true) : [directory];
  return directories.flatMap((parent) => {
    const names = GLOB_MAGIC.test(name) ? matchingNames(parent, name, directoriesOnly) : literalName(parent, name);
    return names.map((found) => joinPath(parent, found));
  });
}

export function glob(pattern: string): string[] {
  return globPath(pattern, false);
}

const DIRECTORY_LOOKUP_TIMEOUT_SECONDS = 3;
const FIRST_DIRECTORY_HOME = /<key>dsAttrTypeStandard:NFSHomeDirectory<\/key>\s*<array>\s*<string>([^<]*)<\/string>/;
const XML_ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&amp;": "&" };
const PASSWD_FILE = "/etc/passwd";
const PASSWD_HOME_FIELD = 5;
const accountHomes = new Map<string, string | null>();

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" &&
    typeof (error as NodeJS.ErrnoException).errno === "number";
}

export function tryReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function tryUserInfo(): { username: string; homedir: string } | null {
  try {
    return userInfo();
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function tryRunDirectoryLookup(name: string): CompletedProcess | null {
  try {
    return run(["dscl", "-plist", ".", "-read", `/Users/${name}`, "NFSHomeDirectory"], DIRECTORY_LOOKUP_TIMEOUT_SECONDS);
  } catch (error) {
    if (error instanceof OSError || error instanceof TimeoutExpired) return null;
    throw error;
  }
}

function directoryServicesHome(name: string): string | null {
  if (process.platform !== "darwin") return null;
  const answer = tryRunDirectoryLookup(name);
  if (answer === null || answer.returncode !== 0) return null;
  const home = FIRST_DIRECTORY_HOME.exec(answer.stdout)?.[1];
  return home === undefined ? null : home.replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

function passwdFileHome(name: string): string | null {
  for (const line of (tryReadText(PASSWD_FILE) ?? "").split("\n")) {
    const fields = line.split(":");
    if (fields[0] === name && fields.length > PASSWD_HOME_FIELD) return fields[PASSWD_HOME_FIELD] ?? null;
  }
  return null;
}

function lookupAccountHome(name: string): string | null {
  const current = tryUserInfo();
  if (current?.username === name) return current.homedir;
  return directoryServicesHome(name) ?? passwdFileHome(name);
}

function accountHome(name: string): string | null {
  if (!accountHomes.has(name)) accountHomes.set(name, lookupAccountHome(name));
  return accountHomes.get(name) ?? null;
}

export function expandUser(path: string): string {
  if (!path.startsWith("~")) return path;
  const slash = path.indexOf("/", 1);
  const end = slash < 0 ? path.length : slash;
  const home = end === 1 ? currentHome() : accountHome(path.slice(1, end));
  if (home === null) return path;
  return rstripChar(home, "/") + path.slice(end) || "/";
}

function currentHome(): string | null {
  const home = environmentValue("HOME");
  if (home !== undefined) return home;
  return tryUserInfo()?.homedir ?? null;
}

export function environmentValue(name: string): string | undefined {
  return Object.hasOwn(process.env, name) ? process.env[name] : undefined;
}

export function expandVars(path: string): string {
  if (!path.includes("$")) return path;
  return path.replace(ENVIRONMENT_VARIABLE, (whole, name: string) => {
    if (name.startsWith("{") && !name.endsWith("}")) return whole;
    const variable = name.startsWith("{") ? name.slice(1, -1) : name;
    return environmentValue(variable) ?? whole;
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

export function pythonStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return "[" + value.map(pythonRepr).join(", ") + "]";
  if (isRecord(value)) return "{" + Object.entries(value).map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`).join(", ") + "}";
  if (typeof value === "number" && !Number.isFinite(value)) return pythonFloatSpelling(value);
  return String(value);
}

function pythonFloatSpelling(value: number): string {
  if (Number.isNaN(value)) return "nan";
  return value > 0 ? "inf" : "-inf";
}

export function pythonJsonDumps(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((item) => pythonJsonDumps(item === undefined ? null : item)).join(", ") + "]";
  if (isRecord(value)) {
    const members = Object.entries(value).filter(([, item]) => item !== undefined);
    return "{" + members.map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`).join(", ") + "}";
  }
  if (typeof value === "number" && !Number.isFinite(value)) return nonFiniteNumberText(value);
  return JSON.stringify(value);
}

function nonFiniteNumberText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}
