import { statSync } from "node:fs";
import { isSystemError } from "./files.ts";
import { rstripChar, trimSpace } from "./text.ts";
import { run } from "./subprocess.ts";
import type { CompletedProcess } from "./subprocess.ts";

export const GIT_TIMEOUT_SECONDS = 8;

export function git(args: readonly string[], cwd: string): CompletedProcess {
  return run(["git", "-C", cwd, ...args], GIT_TIMEOUT_SECONDS);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}

export function gitOutput(args: readonly string[], cwd: string): string | null {
  if (!isDirectory(cwd)) return null;
  const result = git(args, cwd);
  if (result.returncode !== 0) return null;
  return rstripChar(result.stdout, "\n");
}

export function findToplevel(path: string): string | null {
  return gitOutput(["rev-parse", "--show-toplevel"], path);
}

export function normalizeRepoKey(url: string): string | null {
  let trimmed = rstripChar(trimSpace(url), "/");
  if (trimmed.endsWith(".git")) trimmed = trimmed.slice(0, -".git".length);
  const segments = trimmed.split(/[/:]/).filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`.toLowerCase();
}

export function findRepoKey(toplevel: string): string | null {
  const url = gitOutput(["remote", "get-url", "origin"], toplevel);
  return url ? normalizeRepoKey(url) : null;
}

export function findSuperproject(toplevel: string): string | null {
  return gitOutput(["rev-parse", "--show-superproject-working-tree"], toplevel) || null;
}

export function isCommit(toplevel: string, ref: string): boolean {
  return gitOutput(["rev-parse", "-q", "--verify", ref + "^{commit}"], toplevel) !== null;
}

export function findUpstream(toplevel: string, ref: string): string | null {
  const upstream = gitOutput(["rev-parse", "--abbrev-ref", `${ref}@{u}`], toplevel);
  return upstream && isCommit(toplevel, upstream) ? upstream : null;
}

export function currentBranch(toplevel: string): string | null {
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], toplevel);
  return branch === null || branch === "HEAD" ? null : branch;
}
