import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { entryExists, isDir } from "../../measure/lib/measurekit/files.ts"

const TEMP_PREFIX = ".keel-link-"
const TEMP_FILE_MODE = 0o600

export class FileExistsError extends Error {}

export function makedirs(directory: string, mode?: number): void {
  if (isDir(directory)) return
  const parent = path.dirname(directory)
  if (parent !== directory && !fs.existsSync(parent)) makedirs(parent)
  try {
    fs.mkdirSync(directory, { mode })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isDir(directory)) throw error
  }
}

export function writeTextAtomic(file: string, text: string, mode: number): void {
  const directory = path.dirname(file)
  makedirs(directory)
  const tempPath = createTempFile(directory)
  try {
    writeAndSync(tempPath, Buffer.from(text, "utf8"))
    fs.chmodSync(tempPath, mode)
    fs.renameSync(tempPath, file)
  } catch (error) {
    removeIfPresent(tempPath)
    throw error
  }
}

export function replaceWithSymlink(source: string, link: string): void {
  const directory = path.dirname(link)
  makedirs(directory)
  const tempPath = path.join(directory, `${TEMP_PREFIX}${process.pid}-${path.basename(link)}`)
  removeIfPresent(tempPath)
  fs.symlinkSync(source, tempPath)
  try {
    fs.renameSync(tempPath, link)
  } catch (error) {
    fs.unlinkSync(tempPath)
    throw error
  }
}

export function copyFileAtomic(source: string, file: string): void {
  const directory = path.dirname(file)
  makedirs(directory)
  const tempPath = createTempFile(directory)
  try {
    writeAndSync(tempPath, fs.readFileSync(source))
    fs.chmodSync(tempPath, fs.statSync(source).mode & 0o7777)
    fs.renameSync(tempPath, file)
  } catch (error) {
    removeIfPresent(tempPath)
    throw error
  }
}

export function moveAside(file: string, backupPath: string): void {
  if (entryExists(backupPath)) throw new FileExistsError(`backup path already exists: ${backupPath}`)
  makedirs(path.dirname(backupPath), 0o700)
  fs.renameSync(file, backupPath)
}

function createTempFile(directory: string): string {
  for (;;) {
    const tempPath = path.join(directory, TEMP_PREFIX + randomBytes(6).toString("base64url"))
    try {
      fs.closeSync(fs.openSync(tempPath, "wx", TEMP_FILE_MODE))
      return tempPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
}

function writeAndSync(file: string, content: Buffer): void {
  const descriptor = fs.openSync(file, "w")
  try {
    fs.writeSync(descriptor, content)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function removeIfPresent(file: string): void {
  if (entryExists(file)) fs.unlinkSync(file)
}
