import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { decodeStrict } from "../../measure/lib/measurekit/files.ts";
import { isJsonObject, parseStateJson } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { isFile, isSymlink, pathExists, requireUsableFileName, resolvePath } from "./paths.ts";
import { Refusal } from "./refusal.ts";

const TEMPORARY_SUFFIX_LENGTH = 8;
const TEMPORARY_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_";
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const NEWLINES = /\r\n?/g;

export interface ManagedFile {
  kind: "file" | "link";
  content: string;
}

export function readText(path: string): string {
  return decodeStrict(readFileSync(requireUsableFileName(path)), path).replace(NEWLINES, "\n");
}

export function fingerprint(path: string): string | null {
  if (isSymlink(path)) return digest("link", resolvePath(path));
  if (isFile(path)) return digest("file", readText(path));
  if (pathExists(path)) throw new Refusal(`expected a file or symlink: ${path}`);
  return null;
}

export function digest(kind: string, content: string): string {
  return createHash("sha256").update(kind + "\0" + content, "utf8").digest("hex");
}

export function writeAtomic(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = createTemporaryFile(directory, `.${basename(path)}.`);
  try {
    try {
      writeFileSync(temporary.descriptor, content);
    } finally {
      closeSync(temporary.descriptor);
    }
    if (pathExists(path)) chmodSync(temporary.path, statSync(path).mode & PERMISSION_BITS);
    renameSync(temporary.path, path);
  } finally {
    if (existsSync(temporary.path)) unlinkSync(temporary.path);
  }
}

export function readJson(path: string): JsonObject {
  const value = isFile(path) ? parseStateJson(readText(path)) : {};
  if (!isJsonObject(value)) throw new Refusal(`expected an object: ${path}`);
  return value;
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
