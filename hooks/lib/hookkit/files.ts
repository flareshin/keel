import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

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

export function resolveSymlinksKeepingMissingTail(path: string): string {
  const absolute = path.startsWith("/") ? path : process.cwd() + "/" + path;
  return normalize(resolveLinks("/", absolute.slice(1), new Map()).path);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
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
      path = dirname(path);
      continue;
    }
    const linked = join(path, name);
    if (!isSymlink(linked)) {
      path = linked;
      continue;
    }
    if (seen.has(linked)) {
      const known = seen.get(linked) ?? null;
      if (known === null) return { path: join(linked, rest), resolved: false };
      path = known;
      continue;
    }
    seen.set(linked, null);
    const target = resolveLinks(path, readlinkSync(linked), seen);
    if (!target.resolved) return { path: join(target.path, rest), resolved: false };
    path = target.path;
    seen.set(linked, path);
  }
  return { path, resolved: true };
}

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
