import { fileURLToPath } from "node:url"

import { expanduser, pyDirname, pyJoin, realpath } from "./pypath.ts"

export const CHECKOUT_ROOT = pyDirname(pyDirname(pyDirname(pyDirname(realpath(fileURLToPath(import.meta.url))))))

export function keelHome(): string {
  return process.env["KEEL_HOME"] || CHECKOUT_ROOT
}

export function overlayDir(): string {
  return expanduser(process.env["KEEL_OVERLAY_DIR"] || "~/git/keel-overlay")
}

export function dataDir(): string {
  return expanduser(process.env["KEEL_DATA_DIR"] || "~/.claude")
}

export function logsDir(): string {
  return pyJoin(dataDir(), "logs")
}
