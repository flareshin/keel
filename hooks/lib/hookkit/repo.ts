import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isSystemError } from "./files.ts";
import { rstripChar, trimSpace } from "./text.ts";
import { TimeoutExpired } from "../../../measure/lib/measurekit/timeout.ts";
import { OSError, run } from "./subprocess.ts";
import type { CompletedProcess } from "./subprocess.ts";

export const HOOK_GIT_TIMEOUT_SECONDS = 8;
const NOT_A_REPOSITORY_STATUS = 128;
const NOT_A_REPOSITORY_MESSAGE = "not a git repository";

export function git(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): CompletedProcess {
  return run(["git", "-C", cwd, ...args], HOOK_GIT_TIMEOUT_SECONDS, { env });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}

export function gitOutputOrNull(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string | null {
  if (!isDirectory(cwd)) return null;
  const result = git(args, cwd, env);
  if (result.returncode !== 0) return null;
  return rstripChar(result.stdout, "\n");
}

export function findToplevel(path: string): string | null {
  return gitOutputOrNull(["rev-parse", "--show-toplevel"], path);
}

export function isOutsideEveryRepository(path: string): boolean {
  const directory = realDirectoryOf(path);
  if (directory === null) return false;
  const lookup = ["env", "LC_ALL=C", "git", "-C", directory, "rev-parse", "--show-toplevel"];
  try {
    const result = run(lookup, HOOK_GIT_TIMEOUT_SECONDS);
    return result.returncode === NOT_A_REPOSITORY_STATUS && result.stderr.includes(NOT_A_REPOSITORY_MESSAGE);
  } catch (error) {
    if (error instanceof TimeoutExpired || error instanceof OSError) return false;
    throw error;
  }
}

function realDirectoryOf(path: string): string | null {
  const entry = nearestExistingEntry(path);
  if (entry === null) return null;
  try {
    const real = realpathSync(entry);
    return isDirectory(real) ? real : dirname(real);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function nearestExistingEntry(path: string): string | null {
  for (let entry = path; ; entry = dirname(entry)) {
    try {
      lstatSync(entry);
      return entry;
    } catch (error) {
      if (!isSystemError(error)) throw error;
      if (error.code !== "ENOENT" || dirname(entry) === entry) return null;
    }
  }
}

export function normalizeRepoKey(url: string): string | null {
  let trimmed = rstripChar(trimSpace(url), "/");
  if (trimmed.endsWith(".git")) trimmed = trimmed.slice(0, -".git".length);
  const segments = trimmed.split(/[/:]/).filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`.toLowerCase();
}

export function findRepoKey(toplevel: string): string | null {
  const url = gitOutputOrNull(["remote", "get-url", "origin"], toplevel);
  return url ? normalizeRepoKey(url) : null;
}

export function findSuperproject(toplevel: string): string | null {
  return gitOutputOrNull(["rev-parse", "--show-superproject-working-tree"], toplevel) || null;
}

export function isCommit(toplevel: string, ref: string): boolean {
  return gitOutputOrNull(["rev-parse", "-q", "--verify", ref + "^{commit}"], toplevel) !== null;
}

export function findUpstream(toplevel: string, ref: string): string | null {
  const upstream = gitOutputOrNull(["rev-parse", "--abbrev-ref", `${ref}@{u}`], toplevel);
  return upstream && isCommit(toplevel, upstream) ? upstream : null;
}

export function currentBranch(toplevel: string): string | null {
  const branch = gitOutputOrNull(["rev-parse", "--abbrev-ref", "HEAD"], toplevel);
  return branch === null || branch === "HEAD" ? null : branch;
}
