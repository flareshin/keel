import { readFileSync } from 'node:fs';
import { RecursionError, UnicodeDecodeError, ValueError, decodeStrict, pyRepr, pyReprList, pythonJsonDumps, pythonJsonLoads, universalNewlines } from './pycompat.ts';
import type { JsonValue } from './pycompat.ts';

export function dumpFiresLine(record: Record<string, unknown>): string {
  return pythonJsonDumps(record as Record<string, JsonValue>, { sortKeys: true });
}

export function parseStoredJson(bytes: Buffer): unknown {
  return pythonJsonLoads(universalNewlines(decodeStrict(bytes)));
}

export function isStoredJsonTooDeep(error: unknown): boolean {
  return error instanceof RecursionError;
}

export function quoted(text: string): string {
  return pyRepr(text);
}

export function describeCommand(command: string[]): string {
  return pyReprList(command);
}

export function readTsvText(path: string): string {
  return universalNewlines(decodeStrict(readFileSync(path)));
}

export function isPinnedParseFailure(error: unknown): boolean {
  return error instanceof ValueError || error instanceof UnicodeDecodeError;
}
