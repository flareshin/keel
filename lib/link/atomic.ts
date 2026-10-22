import { randomBytes } from "node:crypto"
import fs from "node:fs"

import { isDir, lexists, pyBasename, pyDirname, pyJoin } from "../../measure/lib/measurekit/pypath.ts"

const TEMP_PREFIX = ".keel-link-"
const TEMP_FILE_MODE = 0o600

export class FileExistsError extends Error {}

export function makedirs(directory: string, mode?: number): void {
  if (isDir(directory)) return
  const parent = pyDirname(directory)
  if (parent !== directory && !fs.existsSync(parent)) makedirs(parent)
  try {
    fs.mkdirSync(directory, { mode })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isDir(directory)) throw error
  }
}

export function writeTextAtomic(path: string, text: string, mode: number): void {
  const directory = pyDirname(path)
  makedirs(directory)
  const tempPath = createTempFile(directory)
  try {
    writeAndSync(tempPath, Buffer.from(text, "utf8"))
    fs.chmodSync(tempPath, mode)
    fs.renameSync(tempPath, path)
  } catch (error) {
    removeIfPresent(tempPath)
    throw error
  }
}

export function replaceWithSymlink(source: string, path: string): void {
  const directory = pyDirname(path)
  makedirs(directory)
  const tempPath = pyJoin(directory, `${TEMP_PREFIX}${process.pid}-${pyBasename(path)}`)
  removeIfPresent(tempPath)
  fs.symlinkSync(source, tempPath)
  try {
    fs.renameSync(tempPath, path)
  } catch (error) {
    fs.unlinkSync(tempPath)
    throw error
  }
}

export function copyFileAtomic(source: string, path: string): void {
  const directory = pyDirname(path)
  makedirs(directory)
  const tempPath = createTempFile(directory)
  try {
    writeAndSync(tempPath, fs.readFileSync(source))
    fs.chmodSync(tempPath, fs.statSync(source).mode & 0o7777)
    fs.renameSync(tempPath, path)
  } catch (error) {
    removeIfPresent(tempPath)
    throw error
  }
}

export function moveAside(path: string, backupPath: string): void {
  if (lexists(backupPath)) throw new FileExistsError(`backup path already exists: ${backupPath}`)
  makedirs(pyDirname(backupPath), 0o700)
  fs.renameSync(path, backupPath)
}

function createTempFile(directory: string): string {
  for (;;) {
    const tempPath = pyJoin(directory, TEMP_PREFIX + randomBytes(6).toString("base64url"))
    try {
      fs.closeSync(fs.openSync(tempPath, "wx", TEMP_FILE_MODE))
      return tempPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
}

function writeAndSync(path: string, content: Buffer): void {
  const descriptor = fs.openSync(path, "w")
  try {
    fs.writeSync(descriptor, content)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function removeIfPresent(path: string): void {
  if (lexists(path)) fs.unlinkSync(path)
}
