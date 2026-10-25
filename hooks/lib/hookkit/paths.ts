import { lstatSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { userInfo } from "node:os";
import { isSystemError } from "./files.ts";
import { rstripChar } from "./text.ts";

const ENVIRONMENT_VARIABLE = /\$([A-Za-z0-9_]+|\{[^}]*\}?)/g;

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

function tryUserInfo(): { username: string; homedir: string } | null {
  try {
    return userInfo();
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function currentHome(): string | null {
  const home = environmentValue("HOME");
  if (home !== undefined) return home;
  return tryUserInfo()?.homedir ?? null;
}

function homeOfCurrentUser(name: string): string | null {
  const current = tryUserInfo();
  return current?.username === name ? current.homedir : null;
}

export function expandUser(path: string): string {
  if (!path.startsWith("~")) return path;
  const slash = path.indexOf("/", 1);
  const end = slash < 0 ? path.length : slash;
  const home = end === 1 ? currentHome() : homeOfCurrentUser(path.slice(1, end));
  if (home === null) return path;
  return rstripChar(home, "/") + path.slice(end) || "/";
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
