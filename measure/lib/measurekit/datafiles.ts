import fs from "node:fs"

import { ValueError } from "./pyerrors.ts"
import { readText, newlineSeparatedLines } from "./pyio.ts"
import { pythonJsonDumps, pythonJsonLoads } from "./pyjson.ts"
import { pathExists, pyDirname } from "./pypath.ts"
import { pyStrip } from "./pystr.ts"
import { isJsonObject } from "./pyvalue.ts"
import type { JsonObject, PyValue } from "./pyvalue.ts"

export class TsvError extends Error {}

export type NumberedLine = [number, string]

export function dataLines(path: string): NumberedLine[] {
  const numbered = newlineSeparatedLines(readText(path)).map((line, index): NumberedLine => [index + 1, line])
  return numbered.filter(([, line]) => pyStrip(line) !== "" && !line.startsWith("#"))
}

export function readTsvLines(path: string, header: readonly string[]): [number, string[]][] {
  const contentLines = dataLines(path)
  const first = contentLines[0]
  if (!first) throw new TsvError(`${path}: missing header`)
  const [headerNumber, headerLine] = first
  const headerCells = headerLine.split("\t")
  if (headerCells.length !== header.length || headerCells.some((cell, index) => cell !== header[index])) {
    throw new TsvError(`${path}:${headerNumber}: header must be exactly: ${header.join("\t")}`)
  }
  return contentLines.slice(1).map(([number, line]): [number, string[]] => [number, line.split("\t")])
}

export function readTsvRecords(path: string, header: readonly string[]): Record<string, string>[] {
  return readTsvLines(path, header).map(([number, cells]) => {
    if (cells.length !== header.length) throw new TsvError(`${path}:${number}: expected ${header.length} columns, found ${cells.length}`)
    return Object.fromEntries(header.map((name, index) => [name, cells[index] as string]))
  })
}

export function readJsonl(path: string): { records: JsonObject[]; malformed: number } {
  if (!pathExists(path)) return { records: [], malformed: 0 }
  const records: JsonObject[] = []
  let malformed = 0
  for (const line of newlineSeparatedLines(readText(path)).filter((candidate) => pyStrip(candidate) !== "")) {
    const record = parseRecord(line)
    if (record === null) malformed++
    else records.push(record)
  }
  return { records, malformed }
}

function parseRecord(line: string): JsonObject | null {
  let record: PyValue
  try {
    record = pythonJsonLoads(line)
  } catch (error) {
    if (error instanceof ValueError) return null
    throw error
  }
  return isJsonObject(record) ? record : null
}

export function appendJsonl(path: string, record: object): void {
  fs.mkdirSync(pyDirname(path), { recursive: true })
  fs.appendFileSync(path, pythonJsonDumps(record, { sortKeys: true }) + "\n", "utf8")
}
