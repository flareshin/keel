import { getField, isRecord } from "../lib/hookkit/fields.ts";

const CELL_INDEX = /^cell-(\d+)$/u;
const DEFAULT_LANGUAGE = "python";
const LANGUAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["python", ".py"], ["javascript", ".js"], ["typescript", ".ts"], ["java", ".java"], ["kotlin", ".kt"], ["scala", ".scala"],
  ["go", ".go"], ["rust", ".rs"], ["bash", ".sh"], ["sh", ".sh"], ["zsh", ".zsh"], ["ruby", ".rb"], ["sql", ".sql"],
  ["c++", ".cpp"], ["c", ".c"], ["c#", ".cs"], ["csharp", ".cs"], ["swift", ".swift"], ["perl", ".pl"], ["groovy", ".groovy"],
]);

export interface CodeChange {
  path: string;
  before: string;
  after: string;
}

export function notebookCellChange(notebookPath: string, notebookText: string | null, toolArgs: Record<string, unknown>): CodeChange | null {
  const newSource = getField(toolArgs, "new_source");
  const mode = getField(toolArgs, "edit_mode") ?? "replace";
  if (typeof newSource !== "string" || mode === "delete" || notebookText === null) return null;
  const notebook = parsedNotebook(notebookText);
  if (notebook === null) return null;
  const extension = LANGUAGE_EXTENSIONS.get(languageOf(notebook));
  if (extension === undefined) return null;
  const requestedType = getField(toolArgs, "cell_type");
  let before = "";
  let cellType = requestedType;
  if (mode !== "insert") {
    const cell = cellNamed(notebook.cells, getField(toolArgs, "cell_id"));
    if (cell === null) return null;
    before = sourceOf(cell);
    cellType ??= getField(cell, "cell_type");
  }
  if (cellType !== "code") return null;
  return { path: notebookPath + extension, before, after: newSource };
}

function parsedNotebook(text: string): { cells: unknown[]; metadata: unknown } | null {
  let notebook: unknown;
  try {
    notebook = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(notebook)) return null;
  const cells = getField(notebook, "cells");
  return Array.isArray(cells) ? { cells, metadata: getField(notebook, "metadata") } : null;
}

function languageOf(notebook: { metadata: unknown }): string {
  const info = isRecord(notebook.metadata) ? getField(notebook.metadata, "language_info") : null;
  const name = isRecord(info) ? getField(info, "name") : null;
  return typeof name === "string" ? name.toLowerCase() : DEFAULT_LANGUAGE;
}

function cellNamed(cells: readonly unknown[], cellId: unknown): Record<string, unknown> | null {
  if (typeof cellId !== "string") return null;
  const byId = cells.find((cell) => isRecord(cell) && getField(cell, "id") === cellId);
  if (isRecord(byId)) return byId;
  const index = CELL_INDEX.exec(cellId)?.[1];
  const byIndex = index === undefined ? undefined : cells[Number(index)];
  return isRecord(byIndex) ? byIndex : null;
}

function sourceOf(cell: Record<string, unknown>): string {
  const source = getField(cell, "source");
  if (Array.isArray(source)) return source.filter((line): line is string => typeof line === "string").join("");
  return typeof source === "string" ? source : "";
}
