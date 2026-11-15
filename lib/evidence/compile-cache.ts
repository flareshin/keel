import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, renameSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stateDir } from './env.ts';

export interface Removed {
  files: number;
  bytes: number;
}

interface Folder extends Removed {
  path: string;
  isCurrentNode: boolean;
}

export const COMPILE_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
const CURRENT_NODE_PREFIX = `${process.version}-${process.arch}-`;
export const RETIRED_PREFIX = 'removing-';
const REMOVE_RETRIES = 3;
const REMOVE_SCRIPT = `const { rmSync } = require('node:fs');
for (const path of process.argv.slice(1)) rmSync(path, { recursive: true, force: true, maxRetries: ${REMOVE_RETRIES} });`;

export function compileCacheDir(): string {
  return join(stateDir(), 'node-compile-cache');
}

export function trim(cacheDir: string = compileCacheDir(), limitBytes: number = COMPILE_CACHE_LIMIT_BYTES): Removed {
  const folders = versionFolders(cacheDir);
  const currentBytes = folders.filter((folder) => folder.isCurrentNode).reduce((sum, folder) => sum + folder.bytes, 0);
  const doomed = currentBytes > limitBytes ? folders : folders.filter((folder) => !folder.isCurrentNode);
  removeInBackground(doomed.map((folder) => retire(folder.path)));
  return {
    files: doomed.reduce((sum, folder) => sum + folder.files, 0),
    bytes: doomed.reduce((sum, folder) => sum + folder.bytes, 0),
  };
}

function retire(path: string): string {
  if (basename(path).startsWith(RETIRED_PREFIX)) return path;
  const retired = join(dirname(path), `${RETIRED_PREFIX}${Date.now()}-${basename(path)}`);
  renameSync(path, retired);
  return retired;
}

function removeInBackground(paths: string[]): void {
  if (paths.length === 0) return;
  const remover = spawn(process.execPath, ['-e', REMOVE_SCRIPT, ...paths], { detached: true, stdio: 'ignore' });
  remover.on('error', leaveForNextRun);
  remover.unref();
}

function leaveForNextRun(): void {}

function versionFolders(cacheDir: string): Folder[] {
  return listEntries(cacheDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(cacheDir, entry.name);
      return { path, isCurrentNode: entry.name.startsWith(CURRENT_NODE_PREFIX), ...measure(path) };
    });
}

function measure(folder: string): Removed {
  const total = { files: 0, bytes: 0 };
  for (const entry of listEntries(folder)) {
    const path = join(folder, entry.name);
    const found = entry.isDirectory() ? measure(path) : measureFile(path);
    total.files += found.files;
    total.bytes += found.bytes;
  }
  return total;
}

function measureFile(path: string): Removed {
  const size = ignoringVanished(() => lstatSync(path).size);
  return size === null ? { files: 0, bytes: 0 } : { files: 1, bytes: size };
}

function listEntries(folder: string): Dirent[] {
  return ignoringVanished(() => readdirSync(folder, { withFileTypes: true })) ?? [];
}

function ignoringVanished<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
