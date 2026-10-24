import { readFileSync } from 'node:fs';
import { parseJsonKeepingIntegers } from '../../measure/lib/measurekit/json.ts';
import { PyFloat, RecursionError, UnicodeDecodeError, ValueError, decodeStrict, pyRepr, pyReprList, pythonJsonDumps, pythonJsonLoads, universalNewlines } from './pycompat.ts';
import type { JsonValue } from './pycompat.ts';

export function dumpFiresLine(record: Record<string, unknown>): string {
  return pythonJsonDumps(record as Record<string, JsonValue>, { sortKeys: true });
}

export function parseStoredJson(bytes: Buffer): unknown {
  return withPlainNumbers(pythonJsonLoads(universalNewlines(decodeStrict(bytes))));
}

function withPlainNumbers(parsed: unknown): unknown {
  const holder: { root: unknown } = { root: parsed };
  const pending: Array<[container: any, key: string | number]> = [[holder, 'root']];
  for (let slot = pending.pop(); slot !== undefined; slot = pending.pop()) {
    const [container, key] = slot;
    const value = container[key];
    if (value instanceof PyFloat) {
      container[key] = value.value;
    } else if (typeof value === 'bigint') {
      container[key] = parseJsonKeepingIntegers(value.toString());
    } else if (Array.isArray(value)) {
      value.forEach((_, index) => pending.push([value, index]));
    } else if (typeof value === 'object' && value !== null) {
      for (const member of Object.keys(value)) pending.push([value, member]);
    }
  }
  return holder.root;
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
