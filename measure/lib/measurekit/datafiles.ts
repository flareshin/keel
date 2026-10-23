import fs from "node:fs"
import path from "node:path"

import { readUtf8, splitLines } from "./files.ts"
import { isJsonObject, parseJson, stringifySorted } from "./json.ts"
import type { JsonObject, JsonValue } from "./json.ts"

export class TsvError extends Error {}

export type NumberedLine = [number, string]

export function dataLines(file: string): NumberedLine[] {
  const numbered = splitLines(readUtf8(file)).map((line, index): NumberedLine => [index + 1, line])
  return numbered.filter(([, line]) => line.trim() !== "" && !line.startsWith("#"))
}

export function readTsvLines(file: string, header: readonly string[]): [number, string[]][] {
  const contentLines = dataLines(file)
  const first = contentLines[0]
  if (!first) throw new TsvError(`${file}: missing header`)
  const [headerNumber, headerLine] = first
  const headerCells = headerLine.split("\t")
  if (headerCells.length !== header.length || headerCells.some((cell, index) => cell !== header[index])) {
    throw new TsvError(`${file}:${headerNumber}: header must be exactly: ${header.join("\t")}`)
  }
  return contentLines.slice(1).map(([number, line]): [number, string[]] => [number, line.split("\t")])
}

export function readTsvRecords(file: string, header: readonly string[]): Record<string, string>[] {
  return readTsvLines(file, header).map(([number, cells]) => {
    if (cells.length !== header.length) throw new TsvError(`${file}:${number}: expected ${header.length} columns, found ${cells.length}`)
    return Object.fromEntries(header.map((name, index) => [name, cells[index] as string]))
  })
}

export function readJsonl(file: string): { records: JsonObject[]; malformed: number } {
  if (!fs.existsSync(file)) return { records: [], malformed: 0 }
  const records: JsonObject[] = []
  let malformed = 0
  for (const line of splitLines(readUtf8(file)).filter((candidate) => candidate.trim() !== "")) {
    const record = parseRecord(line)
    if (record === null) malformed++
    else records.push(record)
  }
  return { records, malformed }
}

function parseRecord(line: string): JsonObject | null {
  let record: JsonValue
  try {
    record = parseJson(line)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  return isJsonObject(record) ? record : null
}

export function appendJsonl(file: string, record: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, stringifySorted(record) + "\n", "utf8")
}
