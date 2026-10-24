import { lstatSync, readlinkSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { isSystemError } from "../../hooks/lib/hookkit/pycompat.ts";
import { decodeStrict } from "../../measure/lib/measurekit/files.ts";
import { Refusal } from "./refusal.ts";

const ROOT = "/";
const MAX_SYMLINK_HOPS = 40;
const GLOB_MAGIC = /[*?[]/;

export function isUsableFileName(path: string): boolean {
  return path.isWellFormed() && !path.includes("\0");
}

export function requireUsableFileName(path: string): string {
  if (!isUsableFileName(path)) throw new Refusal("path holds a NUL character or an unpaired surrogate");
  return path;
}

export function cleanPath(path: string): string {
  if (path === "") return ".";
  const anchor = path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? ROOT : "";
  const joined = anchor + path.split("/").filter((part) => part !== "" && part !== ".").join("/");
  return joined === "" ? "." : joined;
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

export function absolutePath(path: string): string {
  const clean = cleanPath(path);
  return isAbsolute(clean) ? clean : cleanPath(process.cwd() + "/" + clean);
}

export function childPath(parent: string, name: string): string {
  return cleanPath(isAbsolute(name) ? name : `${parent}/${name}`);
}

export function isStrictAncestor(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  return path.startsWith(ancestor === ROOT ? ROOT : ancestor + "/");
}

export function hasGlobMagic(text: string): boolean {
  return GLOB_MAGIC.test(text);
}

export function resolvePath(path: string): string {
  const pending = componentsOf(absolutePath(requireUsableFileName(path))).reverse();
  let resolved = ROOT;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.pop() ?? "";
    if (part === "..") {
      resolved = dirname(resolved);
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

function componentsOf(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return decodeStrict(readlinkSync(path, { encoding: "buffer" }), `the target of the symlink ${path}`);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function statOrNull(path: string, follow: boolean): Stats | null {
  if (!isUsableFileName(path)) return null;
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}
