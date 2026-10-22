/**
 * The hook payload contract (DESIGN Interfaces (g)). A missing field means Claude Code changed its payload
 * shape: the hook logs `contract-miss` naming the fields, the keys it got and the Claude Code version.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDir } from "./env.ts";
import { getField, isRecord, isTruthy, joinPath, pythonStr, sortedByCodePoint, strip } from "./pycompat.ts";
import type { Payload } from "./protocol.ts";
import { OSError, run, TimeoutExpired } from "./subprocess.ts";

export const OUTCOME = "contract-miss";
const VERSION_TIMEOUT_SECONDS = 5;
const UNKNOWN_VERSION = "unknown";
const VERSION_RE = /\p{Nd}+\.\p{Nd}+\.\p{Nd}+/u;
const UNSAFE_FILENAME_CHARACTER = /[^\p{L}\p{N}_.-]/gu;

/** The dotted names (`tool_input.message`) whose value is absent, null or an empty string. */
export function missingFields(payload: Payload, ...names: string[]): string[] {
  return names.filter((name) => {
    let value: unknown = payload;
    for (const part of name.split(".")) value = isRecord(value) ? getField(value, part) : null;
    return value === null || value === undefined || value === "";
  });
}

export function missDetail(payload: Payload, missing: readonly string[]): string {
  const keys = sortedByCodePoint(Object.keys(payload)).join(",");
  return `contract-miss: missing ${missing.join(",")}; keys=${keys}; cc_version=${ccVersion(getField(payload, "session_id"))}`;
}

/** `claude --version`, asked once per session and cached under the data dir. */
export function ccVersion(session: unknown): string {
  const sessionName = pythonStr(isTruthy(session) ? session : "-").replace(UNSAFE_FILENAME_CHARACTER, "_");
  const cache = joinPath(dataDir(), "state", "keel", "sessions", `${sessionName}.cc-version`);
  const cached = readCachedVersion(cache);
  if (cached !== null) return cached;
  const version = askClaude();
  writeCachedVersion(cache, version);
  return version;
}

function readCachedVersion(cache: string): string | null {
  try {
    return strip(readFileSync(cache, "utf8")) || UNKNOWN_VERSION;
  } catch {
    return null;
  }
}

function writeCachedVersion(cache: string, version: string): void {
  try {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, version, "utf8");
  } catch {
    return;
  }
}

function askClaude(): string {
  let stdout: string;
  try {
    stdout = run(["claude", "--version"], VERSION_TIMEOUT_SECONDS).stdout;
  } catch (error) {
    if (error instanceof OSError || error instanceof TimeoutExpired) return UNKNOWN_VERSION;
    throw error;
  }
  return VERSION_RE.exec(stdout)?.[0] ?? UNKNOWN_VERSION;
}
