import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { joinPath, normalizePath } from "./pycompat.ts";

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1);
  return head === "" || /^\/+$/.test(head) ? head : head.replace(/\/+$/, "");
}

export function realpath(path: string): string {
  const absolute = path.startsWith("/") ? path : joinPath(process.cwd(), path);
  return normalizePath(resolveLinks("/", absolute.slice(1), new Map()).path);
}

interface Resolution {
  path: string;
  resolved: boolean;
}

function resolveLinks(start: string, relative: string, seen: Map<string, string | null>): Resolution {
  let path = start;
  let rest = relative;
  if (rest.startsWith("/")) {
    path = "/";
    rest = rest.replace(/^\/+/, "");
  }
  while (rest !== "") {
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? "" : rest.slice(slash + 1);
    if (name === "" || name === ".") continue;
    if (name === "..") {
      path = path === "/" ? "/" : dirname(path);
      continue;
    }
    const linked = joinPath(path, name);
    if (!isSymlink(linked)) {
      path = linked;
      continue;
    }
    if (seen.has(linked)) {
      const known = seen.get(linked) ?? null;
      if (known === null) return { path: joinPath(linked, rest), resolved: false };
      path = known;
      continue;
    }
    seen.set(linked, null);
    const target = resolveLinks(path, readlinkSync(linked), seen);
    if (!target.resolved) return { path: joinPath(target.path, rest), resolved: false };
    path = target.path;
    seen.set(linked, path);
  }
  return { path, resolved: true };
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shlexQuote(text: string): string {
  if (text === "") return "''";
  if (SHELL_SAFE.test(text)) return text;
  return "'" + text.replaceAll("'", `'"'"'`) + "'";
}

const UNIVERSAL_NEWLINE = /\r\n|\r/g;

export function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8").replace(UNIVERSAL_NEWLINE, "\n");
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.path === undefined) failure.path = path;
    throw failure;
  }
}
