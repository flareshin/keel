import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDir } from "./env.ts";
import { getField, isNonEmptyString, isRecord } from "./fields.ts";
import { isSystemError } from "./files.ts";
import { joinPath } from "./paths.ts";
import { trimSpace } from "./text.ts";
import { compareCodePoints } from "../../../measure/lib/measurekit/json.ts";
import type { Payload } from "./protocol.ts";
import { OSError, run, TimeoutExpired } from "./subprocess.ts";

export const OUTCOME = "contract-miss";
const VERSION_TIMEOUT_SECONDS = 5;
const UNKNOWN_VERSION = "unknown";
const VERSION_RE = /\p{Nd}+\.\p{Nd}+\.\p{Nd}+/u;
const UNSAFE_FILENAME_CHARACTER = /[^\p{L}\p{N}_.-]/gu;

export function missingFields(payload: Payload, ...names: string[]): string[] {
  return names.filter((name) => {
    let value: unknown = payload;
    for (const part of name.split(".")) value = isRecord(value) ? getField(value, part) : null;
    return value === null || value === undefined || value === "";
  });
}

export function missDetail(payload: Payload, missing: readonly string[]): string {
  const keys = Object.keys(payload).sort(compareCodePoints).join(",");
  return `contract-miss: missing ${missing.join(",")}; keys=${keys}; cc_version=${ccVersion(getField(payload, "session_id"))}`;
}

export function ccVersion(session: unknown): string {
  const sessionName = (isNonEmptyString(session) ? session : "-").replace(UNSAFE_FILENAME_CHARACTER, "_");
  const cache = joinPath(dataDir(), "state", "keel", "sessions", `${sessionName}.cc-version`);
  const cached = tryReadCachedVersion(cache);
  if (cached !== null) return cached;
  const version = askClaude();
  tryWriteCachedVersion(cache, version);
  return version;
}

function tryReadCachedVersion(cache: string): string | null {
  try {
    return trimSpace(readFileSync(cache, "utf8")) || UNKNOWN_VERSION;
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

function tryWriteCachedVersion(cache: string, version: string): void {
  try {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, version, "utf8");
  } catch (error) {
    if (!isSystemError(error)) throw error;
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
