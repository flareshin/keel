import { readFileSync, statSync } from "node:fs";
import { splitLines } from "../../../measure/lib/measurekit/files.ts";
import { arraysEqual, trimSpace } from "./text.ts";
import { isSystemError } from "./files.ts";

export class OverlayDataError extends Error {
  override name = "OverlayDataError";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}

export function readTsv(path: string, header: readonly string[], optional: readonly string[] = []): Array<Record<string, string>> {
  if (!isFile(path)) return [];
  const withOptional = [...header, ...optional];
  const rows: Array<Record<string, string>> = [];
  let columns: string[] | null = null;
  splitLines(readFileSync(path, "utf8")).forEach((line, index) => {
    const number = index + 1;
    if (trimSpace(line) === "" || line.startsWith("#")) return;
    const cells = line.split("\t");
    if (columns === null) {
      if (!arraysEqual(cells, header) && !arraysEqual(cells, withOptional)) {
        throw new OverlayDataError(`${path}:${number}: header must be ${withOptional.join("\\t")}`);
      }
      columns = cells;
      return;
    }
    if (cells.length !== columns.length) throw new OverlayDataError(`${path}:${number}: expected ${columns.length} columns`);
    const row: Record<string, string> = {};
    columns.forEach((column, position) => {
      row[column] = cells[position] ?? "";
    });
    rows.push(row);
  });
  return rows;
}
