import { readSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { isRecord, isTruthy, pythonStr } from "./pycompat.ts";

const NEWLINES = /\r\n|\r/g;
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const READ_CHUNK_BYTES = 1 << 16;

export class ValueError extends Error {
  override name = "ValueError";
}

export class AttributeError extends Error {
  override name = "AttributeError";
}

export function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  return Array.isArray(value) ? "list" : "dict";
}

export function pythonList(value: unknown): unknown[] {
  if (!isTruthy(value)) return [];
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string") return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  throw new TypeError(`'${pythonTypeName(value)}' object is not iterable`);
}

interface ErrnoClass {
  className: string;
  description: string;
}

const ERRNO_CLASSES: Readonly<Record<string, ErrnoClass>> = {
  ENOENT: { className: "FileNotFoundError", description: "No such file or directory" },
  EPERM: { className: "PermissionError", description: "Operation not permitted" },
  EACCES: { className: "PermissionError", description: "Permission denied" },
  EEXIST: { className: "FileExistsError", description: "File exists" },
  ENOTDIR: { className: "NotADirectoryError", description: "Not a directory" },
  EISDIR: { className: "IsADirectoryError", description: "Is a directory" },
};

function errnoClassOf(error: unknown): ErrnoClass | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && Object.hasOwn(ERRNO_CLASSES, code) ? ERRNO_CLASSES[code] : undefined;
}

export function pythonErrorName(error: unknown): string {
  const errnoClass = errnoClassOf(error);
  if (errnoClass) return errnoClass.className;
  return error instanceof Error ? error.name : "Exception";
}

export function describeError(error: unknown): string {
  return `${pythonErrorName(error)}: ${pythonErrorText(error)}`;
}

function pythonErrorText(error: unknown): string {
  const errnoClass = errnoClassOf(error);
  const failure = error as NodeJS.ErrnoException;
  if (!errnoClass) return error instanceof Error ? error.message : String(error);
  const number = constants.errno[failure.code as keyof typeof constants.errno];
  const filename = failure.path === undefined ? "" : `: ${pythonStr([failure.path]).slice(1, -1)}`;
  return `[Errno ${number}] ${errnoClass.description}${filename}`;
}

export function readStdin(): string {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  for (;;) {
    let count: number;
    try {
      count = readSync(STDIN, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF" || code === "EBADF") break;
      throw error;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString("utf8").replace(NEWLINES, "\n");
}

export function printLine(text: string): void {
  writeAll(STDOUT, text + "\n");
}

export function writeStderr(text: string): void {
  writeAll(STDERR, text);
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(descriptor, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

export function stripChars(text: string, chars: string): string {
  const characters = Array.from(text);
  let start = 0;
  let end = characters.length;
  while (start < end && chars.includes(characters[start] ?? "")) start += 1;
  while (end > start && chars.includes(characters[end - 1] ?? "")) end -= 1;
  return characters.slice(start, end).join("");
}
