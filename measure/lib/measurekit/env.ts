import path from "node:path"
import { fileURLToPath } from "node:url"

import { expandHome, resolveLinks } from "./files.ts"

export const CHECKOUT_ROOT = path.resolve(path.dirname(resolveLinks(fileURLToPath(import.meta.url))), "..", "..", "..")

export function keelHome(): string {
  return process.env["KEEL_HOME"] || CHECKOUT_ROOT
}

export function overlayDir(): string {
  return expandHome(process.env["KEEL_OVERLAY_DIR"] || "~/git/keel-overlay")
}

export function dataDir(): string {
  return expandHome(process.env["KEEL_DATA_DIR"] || "~/.claude")
}

export function logsDir(): string {
  return path.join(dataDir(), "logs")
}
