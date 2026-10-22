import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isRecord } from "../../hooks/lib/hookkit/pycompat.ts";
import { ValueError } from "./pyerrors.ts";
import { fileMode, isFile, isSymlink, nameOf, parentOf, pathExists, readText, resolvePath, sha256Hex } from "./pyfs.ts";
import { pythonJsonLoads } from "./pyjson.ts";
import type { JsonValue } from "./pyjson.ts";

const TEMPORARY_SUFFIX_LENGTH = 8;
const TEMPORARY_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_";
const PRIVATE_FILE_MODE = 0o600;

export interface ManagedFile {
  kind: "file" | "link";
  content: string;
}

export function fingerprint(path: string): string | null {
  if (isSymlink(path)) return digest("link", resolvePath(path));
  if (isFile(path)) return digest("file", readText(path));
  if (pathExists(path)) throw new ValueError(`expected a file or symlink: ${path}`);
  return null;
}

export function digest(kind: string, content: string): string {
  return sha256Hex(kind + "\0" + content);
}

function randomSuffix(): string {
  return Array.from(randomBytes(TEMPORARY_SUFFIX_LENGTH), (byte) => TEMPORARY_SUFFIX_ALPHABET[byte % TEMPORARY_SUFFIX_ALPHABET.length]).join("");
}

function createTemporaryFile(directory: string, prefix: string): { descriptor: number; path: string } {
  for (;;) {
    const path = `${directory}/${prefix}${randomSuffix()}`;
    try {
      return { descriptor: openSync(path, "wx", PRIVATE_FILE_MODE), path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function writeAtomic(path: string, content: string): void {
  const directory = parentOf(path);
  mkdirSync(directory, { recursive: true });
  const temporary = createTemporaryFile(directory, `.${nameOf(path)}.`);
  try {
    try {
      writeFileSync(temporary.descriptor, content);
    } finally {
      closeSync(temporary.descriptor);
    }
    if (pathExists(path)) chmodSync(temporary.path, fileMode(path));
    renameSync(temporary.path, path);
  } finally {
    if (existsSync(temporary.path)) unlinkSync(temporary.path);
  }
}

export function readJson(path: string): { [key: string]: JsonValue } {
  const value = isFile(path) ? pythonJsonLoads(readText(path)) : {};
  if (!isRecord(value)) throw new ValueError(`expected an object: ${path}`);
  return value as { [key: string]: JsonValue };
}
