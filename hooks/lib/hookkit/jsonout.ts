import { RecursionError, ValueError } from "./errors.ts";
import { isRecord } from "./fields.ts";
import { MAX_JSON_DEPTH } from "../../../measure/lib/measurekit/json.ts";

const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
const TOO_DEEP_MESSAGE = "maximum recursion depth exceeded while encoding a JSON object";

interface Container {
  source: object;
  opener: string;
  closer: string;
  items: unknown[];
  keys: string[] | null;
}

interface OpenContainer extends Container {
  index: number;
}

function containerOf(value: unknown): Container | null {
  if (Array.isArray(value)) {
    return { source: value, opener: "[", closer: "]", items: value.map((item) => (item === undefined ? null : item)), keys: null };
  }
  if (!isRecord(value)) return null;
  const members = Object.entries(value).filter(([, item]) => item !== undefined);
  return { source: value, opener: "{", closer: "}", items: members.map(([, item]) => item), keys: members.map(([key]) => key) };
}

function scalarText(value: unknown): string {
  return typeof value === "number" && !Number.isFinite(value) ? nonFiniteNumberText(value) : JSON.stringify(value);
}

export function pythonJsonDumps(value: unknown): string {
  const parts: string[] = [];
  const open: OpenContainer[] = [];
  const active = new Set<object>();
  let next = value;
  for (;;) {
    const container = containerOf(next);
    if (container === null) {
      parts.push(scalarText(next));
    } else if (open.length >= MAX_JSON_DEPTH) {
      throw new RecursionError(TOO_DEEP_MESSAGE);
    } else if (active.has(container.source)) {
      throw new ValueError("Circular reference detected");
    } else if (container.items.length === 0) {
      parts.push(container.opener + container.closer);
    } else {
      active.add(container.source);
      open.push({ ...container, index: 0 });
      parts.push(container.opener + memberPrefix(container, 0));
      next = container.items[0];
      continue;
    }
    const following = closeFinishedContainers(open, active, parts);
    if (following === null) return parts.join("");
    next = following.value;
  }
}

function closeFinishedContainers(open: OpenContainer[], active: Set<object>, parts: string[]): { value: unknown } | null {
  for (;;) {
    const innermost = open.at(-1);
    if (innermost === undefined) return null;
    innermost.index += 1;
    if (innermost.index < innermost.items.length) {
      parts.push(", " + memberPrefix(innermost, innermost.index));
      return { value: innermost.items[innermost.index] };
    }
    parts.push(innermost.closer);
    active.delete(innermost.source);
    open.pop();
  }
}

function memberPrefix(container: Container, index: number): string {
  return container.keys === null ? "" : `${JSON.stringify(container.keys[index] ?? "")}: `;
}

function nonFiniteNumberText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}

export function dumpsAscii(value: unknown): string {
  return pythonJsonDumps(value).replace(NOT_PRINTABLE_ASCII, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
