import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { isSystemError } from "../../hooks/lib/hookkit/pycompat.ts";
import { UnicodeEncodeError, ValueError } from "./pyerrors.ts";

const ROOT = "/";
const MAX_SYMLINK_HOPS = 40;
const GLOB_MAGIC = /[*?[]/;
const NEWLINES = /\r\n?/g;
const UNSAFE_SHELL_CHARACTER = /[^A-Za-z0-9_@%+=:,./-]/;
const ASCII_LIMIT = 0x80;
const CONTINUATION_LOW = 0x80;
const CONTINUATION_HIGH = 0xbf;
const SURROGATE_ESCAPE_BASE = 0xdc00;
const ESCAPED_BYTE_FIRST = 0xdc80;
const ESCAPED_BYTE_LAST = 0xdcff;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;
const ANY_SURROGATE = /[\ud800-\udfff]/;
const BYTE_MASK = 0xff;

export function purePath(path: string): string {
  if (path === "") return ".";
  const anchor = path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? ROOT : "";
  const joined = anchor + path.split("/").filter((part) => part !== "" && part !== ".").join("/");
  return joined === "" ? "." : joined;
}

export function parentOf(path: string): string {
  const pure = purePath(path);
  const cut = pure.lastIndexOf("/");
  if (cut < 0) return ".";
  const head = pure.slice(0, cut);
  return head.replaceAll("/", "") === "" ? pure.slice(0, cut + 1) : head;
}

export function nameOf(path: string): string {
  const pure = purePath(path);
  return pure === "." ? "" : pure.slice(pure.lastIndexOf("/") + 1);
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

export function absolutePath(path: string): string {
  const pure = purePath(path);
  return isAbsolute(pure) ? pure : purePath(process.cwd() + "/" + pure);
}

export function childPath(parent: string, name: string): string {
  return purePath(isAbsolute(name) ? name : `${parent}/${name}`);
}

export function isStrictAncestor(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  return path.startsWith(ancestor === ROOT ? ROOT : ancestor + "/");
}

export function hasGlobMagic(text: string): boolean {
  return GLOB_MAGIC.test(text);
}

function componentsOf(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

export function resolvePath(path: string): string {
  const pending = componentsOf(absolutePath(path)).reverse();
  let resolved = ROOT;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.pop() ?? "";
    if (part === "..") {
      resolved = parentOf(resolved);
      continue;
    }
    const candidate = resolved === ROOT ? ROOT + part : `${resolved}/${part}`;
    const target = linkTarget(candidate);
    hops += target === null ? 0 : 1;
    if (target === null || hops > MAX_SYMLINK_HOPS) {
      resolved = candidate;
      continue;
    }
    if (isAbsolute(target)) resolved = ROOT;
    pending.push(...componentsOf(target).reverse());
  }
  return resolved;
}

function isLoneSurrogate(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  if (unit < HIGH_SURROGATE_FIRST || unit > LOW_SURROGATE_LAST) return false;
  if (unit <= HIGH_SURROGATE_LAST) {
    const next = text.charCodeAt(index + 1);
    return !(next >= LOW_SURROGATE_FIRST && next <= LOW_SURROGATE_LAST);
  }
  const before = text.charCodeAt(index - 1);
  return !(before >= HIGH_SURROGATE_FIRST && before <= HIGH_SURROGATE_LAST);
}

function surrogateFailure(text: string, index: number): UnicodeEncodeError {
  const first = Array.from(text.slice(0, index)).length;
  let end = index + 1;
  while (end < text.length && isLoneSurrogate(text, end)) end += 1;
  const last = first + (end - index) - 1;
  const unit = text.charCodeAt(index).toString(16).padStart(4, "0");
  const subject = last === first ? `character '\\u${unit}' in position ${first}` : `characters in position ${first}-${last}`;
  return new UnicodeEncodeError(`'utf-8' codec can't encode ${subject}: surrogates not allowed`);
}

export function encodeFileSystemPath(path: string): Buffer {
  if (!ANY_SURROGATE.test(path)) return Buffer.from(path, "utf8");
  const pieces: Buffer[] = [];
  let plainStart = 0;
  for (let index = 0; index < path.length; index += 1) {
    if (!isLoneSurrogate(path, index)) continue;
    const unit = path.charCodeAt(index);
    if (unit < ESCAPED_BYTE_FIRST || unit > ESCAPED_BYTE_LAST) throw surrogateFailure(path, index);
    pieces.push(Buffer.from(path.slice(plainStart, index), "utf8"), Buffer.from([unit & BYTE_MASK]));
    plainStart = index + 1;
  }
  pieces.push(Buffer.from(path.slice(plainStart), "utf8"));
  return Buffer.concat(pieces);
}

function pathBytes(path: string): Buffer {
  const bytes = encodeFileSystemPath(path);
  if (bytes.includes(0)) throw new ValueError("lstat: embedded null character in path");
  return bytes;
}

function statOrNull(path: string, follow: boolean): Stats | null {
  try {
    const bytes = pathBytes(path);
    return follow ? statSync(bytes) : lstatSync(bytes);
  } catch (error) {
    if (error instanceof ValueError || isSystemError(error)) return null;
    throw error;
  }
}

export function pathExists(path: string): boolean {
  return statOrNull(path, true) !== null;
}

export function isFile(path: string): boolean {
  return statOrNull(path, true)?.isFile() ?? false;
}

export function isDirectory(path: string): boolean {
  return statOrNull(path, true)?.isDirectory() ?? false;
}

export function isSymlink(path: string): boolean {
  return statOrNull(path, false)?.isSymbolicLink() ?? false;
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function linkTarget(path: string): string | null {
  const bytes = pathBytes(path);
  try {
    return lstatSync(bytes).isSymbolicLink() ? decodeUtf8WithSurrogateEscape(readlinkSync(bytes, { encoding: "buffer" })) : null;
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

interface Utf8Shape {
  continuations: number;
  secondByteLow: number;
  secondByteHigh: number;
}

function utf8Shape(lead: number): Utf8Shape | null {
  const shape = (continuations: number, low = CONTINUATION_LOW, high = CONTINUATION_HIGH): Utf8Shape =>
    ({ continuations, secondByteLow: low, secondByteHigh: high });
  if (lead >= 0xc2 && lead <= 0xdf) return shape(1);
  if (lead === 0xe0) return shape(2, 0xa0);
  if (lead === 0xed) return shape(2, CONTINUATION_LOW, 0x9f);
  if (lead >= 0xe1 && lead <= 0xef) return shape(2);
  if (lead === 0xf0) return shape(3, 0x90);
  if (lead === 0xf4) return shape(3, CONTINUATION_LOW, 0x8f);
  if (lead >= 0xf1 && lead <= 0xf3) return shape(3);
  return null;
}

interface Utf8Problem {
  start: number;
  end: number;
  reason: string;
}

function utf8Problem(bytes: Buffer, from: number): Utf8Problem | null {
  let index = from;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    if (lead < ASCII_LIMIT) {
      index += 1;
      continue;
    }
    const shape = utf8Shape(lead);
    if (shape === null) return { start: index, end: index + 1, reason: "invalid start byte" };
    for (let offset = 1; offset <= shape.continuations; offset += 1) {
      const byte = bytes[index + offset];
      if (byte === undefined) return { start: index, end: index + offset, reason: "unexpected end of data" };
      const low = offset === 1 ? shape.secondByteLow : CONTINUATION_LOW;
      const high = offset === 1 ? shape.secondByteHigh : CONTINUATION_HIGH;
      if (byte < low || byte > high) return { start: index, end: index + offset, reason: "invalid continuation byte" };
    }
    index += shape.continuations + 1;
  }
  return null;
}

function decodeFailure(bytes: Buffer, problem: Utf8Problem): string {
  const where = problem.end - problem.start === 1
    ? `byte 0x${(bytes[problem.start] ?? 0).toString(16).padStart(2, "0")} in position ${problem.start}`
    : `bytes in position ${problem.start}-${problem.end - 1}`;
  return `'utf-8' codec can't decode ${where}: ${problem.reason}`;
}

export function decodeUtf8(bytes: Buffer): string {
  const problem = utf8Problem(bytes, 0);
  if (problem !== null) throw new ValueError(decodeFailure(bytes, problem));
  return bytes.toString("utf8");
}

export function decodeUtf8WithSurrogateEscape(bytes: Buffer): string {
  let text = "";
  let from = 0;
  for (;;) {
    const problem = utf8Problem(bytes, from);
    if (problem === null) return text + bytes.subarray(from).toString("utf8");
    text += bytes.subarray(from, problem.start).toString("utf8");
    for (let index = problem.start; index < problem.end; index += 1) text += String.fromCharCode(SURROGATE_ESCAPE_BASE + (bytes[index] ?? 0));
    from = problem.end;
  }
}

export function pythonStdinIsLenient(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["PYTHONUTF8"] !== "0") return true;
  const locale = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"] || "";
  return locale === "" || locale === "C" || locale === "POSIX";
}

export function translateNewlines(text: string): string {
  return text.replace(NEWLINES, "\n");
}

function readBytes(path: string): Buffer {
  const bytes = encodeFileSystemPath(path);
  if (bytes.includes(0)) throw new ValueError("embedded null byte");
  try {
    return readFileSync(bytes);
  } catch (error) {
    if (isSystemError(error)) error.path = path;
    throw error;
  }
}

export function readText(path: string): string {
  return translateNewlines(decodeUtf8(readBytes(path)));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function shellQuote(text: string): string {
  if (text === "") return "''";
  if (!UNSAFE_SHELL_CHARACTER.test(text)) return text;
  return "'" + text.replaceAll("'", "'\"'\"'") + "'";
}
