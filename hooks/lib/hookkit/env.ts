import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { expandUser, joinPath } from "./paths.ts";

export function dataDir(): string {
  return expandUser(process.env["KEEL_DATA_DIR"] || "~/.claude");
}

export function overlayDir(): string {
  return expandUser(process.env["KEEL_OVERLAY_DIR"] || "~/git/keel-overlay");
}

export function overlayPath(...parts: string[]): string {
  return joinPath(overlayDir(), ...parts);
}

export function keelHome(): string {
  const configured = process.env["KEEL_HOME"];
  if (configured) return expandUser(configured);
  const hookkitDir = dirname(realpathSync(import.meta.filename));
  return dirname(dirname(dirname(hookkitDir)));
}

export function keelCli(): string {
  return process.env["KEEL_CLI"] || joinPath(keelHome(), "bin", "keel");
}

export function boundaryScanner(): string {
  return process.env["KEEL_BOUNDARY"] || joinPath(keelHome(), "measure", "boundary");
}
