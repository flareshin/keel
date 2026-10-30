import path from "node:path"

import { expandHome } from "./files.ts"

export const FIRES_LOG = "keel-fires.jsonl"
export const SYNTHETIC_FIRES_LOG = "keel-fires-synthetic.jsonl"
const REAL_DATA_DIR = "~/.claude"
const NO_SESSION = "-"
const AGENT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function firesLogName(session: string, dataDir: string): string {
  const writesRealLog = path.resolve(dataDir) === path.resolve(expandHome(REAL_DATA_DIR))
  return writesRealLog && isSyntheticSession(session) ? SYNTHETIC_FIRES_LOG : FIRES_LOG
}

export function isSyntheticSession(session: unknown): boolean {
  return typeof session === "string" && session !== NO_SESSION && !AGENT_SESSION_ID.test(session)
}
