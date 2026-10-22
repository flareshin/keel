import { codePointLength, compareCodePoints } from "../../hooks/lib/hookkit/pycompat.ts";
import { ValueError } from "./pyerrors.ts";

export type JsonValue = null | boolean | number | bigint | string | JsonValue[] | { [key: string]: JsonValue };

export interface DumpOptions {
  indent?: number;
  sortKeys?: boolean;
  ensureAscii?: boolean;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const STRING_BREAK = /["\\\x00-\x1f]/g;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HEX4 = /^[0-9a-fA-F]{4}$/;
const MAX_INTEGER_DIGITS = 4300;
const FLOAT_FIXED_LIMIT = 16;
const FLOAT_SMALL_LIMIT = -4;
const UNICODE_ESCAPE_WIDTH = 4;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;
const ESCAPE_UNIT_LENGTH = 6;
const CONSTANTS: ReadonlyArray<readonly [string, number]> = [["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]];

export class JSONDecodeError extends ValueError {
  constructor(message: string, text: string, position: number) {
    super(`${message}: ${coordinates(text, position)}`);
    this.name = "JSONDecodeError";
  }
}

function coordinates(text: string, position: number): string {
  const before = text.slice(0, position);
  const lineStart = before.lastIndexOf("\n");
  const line = before.split("\n").length;
  const column = lineStart < 0 ? codePointLength(before) + 1 : codePointLength(before.slice(lineStart + 1)) + 1;
  return `line ${line} column ${column} (char ${codePointLength(before)})`;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && WHITESPACE.has(text[index] ?? "")) index += 1;
  return index;
}

export function pythonJsonLoads(text: string): JsonValue {
  if (text.startsWith("\ufeff")) throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  const [value, end] = scanValue(text, skipWhitespace(text, 0));
  const last = skipWhitespace(text, end);
  if (last !== text.length) throw new JSONDecodeError("Extra data", text, last);
  return value;
}

type Frame = { items: JsonValue[] } | { members: { [key: string]: JsonValue }; key: string };

function scanValue(text: string, start: number): [JsonValue, number] {
  const open: Frame[] = [];
  let index = start;
  for (;;) {
    let value: JsonValue;
    const opening = text[index];
    if (opening === "[" || opening === "{") {
      const first = skipWhitespace(text, index + 1);
      if (text[first] !== (opening === "[" ? "]" : "}")) {
        if (opening === "[") {
          open.push({ items: [] });
          index = first;
        } else {
          const [key, valueStart] = scanMemberKey(text, first);
          open.push({ members: {}, key });
          index = valueStart;
        }
        continue;
      }
      value = opening === "[" ? [] : {};
      index = first + 1;
    } else {
      [value, index] = scanScalar(text, index);
    }
    for (;;) {
      const frame = open[open.length - 1];
      if (frame === undefined) return [value, index];
      if ("items" in frame) frame.items.push(value);
      else Object.defineProperty(frame.members, frame.key, { value, enumerable: true, writable: true, configurable: true });
      index = skipWhitespace(text, index);
      const closer = "items" in frame ? "]" : "}";
      if (text[index] === closer) {
        open.pop();
        value = "items" in frame ? frame.items : frame.members;
        index += 1;
        continue;
      }
      if (text[index] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", text, index);
      const comma = index;
      index = skipWhitespace(text, index + 1);
      if (text[index] === closer) {
        throw new JSONDecodeError(`Illegal trailing comma before end of ${"items" in frame ? "array" : "object"}`, text, comma);
      }
      if (!("items" in frame)) {
        const [key, valueStart] = scanMemberKey(text, index);
        frame.key = key;
        index = valueStart;
      }
      break;
    }
  }
}

function scanMemberKey(text: string, index: number): [string, number] {
  if (text[index] !== '"') throw new JSONDecodeError("Expecting property name enclosed in double quotes", text, index);
  const [key, afterKey] = scanString(text, index);
  const colon = skipWhitespace(text, afterKey);
  if (text[colon] !== ":") throw new JSONDecodeError("Expecting ':' delimiter", text, colon);
  return [key, skipWhitespace(text, colon + 1)];
}

function scanScalar(text: string, index: number): [JsonValue, number] {
  const character = text[index];
  if (character === '"') return scanString(text, index);
  if (text.startsWith("null", index)) return [null, index + 4];
  if (text.startsWith("true", index)) return [true, index + 4];
  if (text.startsWith("false", index)) return [false, index + 5];
  NUMBER.lastIndex = index;
  const number = NUMBER.exec(text);
  if (number !== null) return [parseNumber(number), index + number[0].length];
  for (const [name, value] of CONSTANTS) if (text.startsWith(name, index)) return [value, index + name.length];
  throw new JSONDecodeError("Expecting value", text, index);
}

function parseNumber(match: RegExpExecArray): number | bigint {
  const literal = match[0];
  if (match[1] !== undefined || match[2] !== undefined) return Number(literal);
  const digits = literal.startsWith("-") ? literal.length - 1 : literal.length;
  if (digits > MAX_INTEGER_DIGITS) {
    throw new ValueError(`Exceeds the limit (${MAX_INTEGER_DIGITS} digits) for integer string conversion: value has ${digits} digits; ` +
      "use sys.set_int_max_str_digits() to increase the limit");
  }
  const number = Number(literal);
  return Number.isSafeInteger(number) ? number : BigInt(literal);
}

function scanString(text: string, quote: number): [string, number] {
  let index = quote + 1;
  let result = "";
  for (;;) {
    STRING_BREAK.lastIndex = index;
    const found = STRING_BREAK.exec(text);
    if (found === null) throw new JSONDecodeError("Unterminated string starting at", text, quote);
    result += text.slice(index, found.index);
    const terminator = found[0];
    if (terminator === '"') return [result, found.index + 1];
    if (terminator !== "\\") throw new JSONDecodeError("Invalid control character at", text, found.index);
    const [piece, next] = scanEscape(text, found.index, quote);
    result += piece;
    index = next;
  }
}

function scanEscape(text: string, backslash: number, quote: number): [string, number] {
  const kind = text[backslash + 1];
  if (kind === undefined) throw new JSONDecodeError("Unterminated string starting at", text, quote);
  if (kind !== "u") {
    const plain = ESCAPES[kind];
    if (plain === undefined) throw new JSONDecodeError("Invalid \\escape", text, backslash);
    return [plain, backslash + 2];
  }
  const afterDigits = backslash + 2 + UNICODE_ESCAPE_WIDTH;
  const first = hexUnit(text, backslash + 1, afterDigits);
  if (first >= HIGH_SURROGATE_FIRST && first <= HIGH_SURROGATE_LAST && afterDigits + ESCAPE_UNIT_LENGTH < text.length &&
      text.startsWith("\\u", afterDigits)) {
    const second = hexUnit(text, afterDigits + 1, afterDigits + 2 + UNICODE_ESCAPE_WIDTH);
    if (second >= LOW_SURROGATE_FIRST && second <= LOW_SURROGATE_LAST) {
      return [String.fromCharCode(first, second), afterDigits + ESCAPE_UNIT_LENGTH];
    }
  }
  return [String.fromCharCode(first), afterDigits];
}

function hexUnit(text: string, unit: number, afterDigits: number): number {
  const digits = text.slice(unit + 1, afterDigits);
  if (afterDigits > text.length || !HEX4.test(digits)) throw new JSONDecodeError("Invalid \\uXXXX escape", text, unit);
  return parseInt(digits, 16);
}

const ASCII_PRINTABLE_ONLY = /[^ -~]|["\\]/g;
const CONTROL_AND_QUOTES = /[\x00-\x1f"\\]/g;
const SHORT_ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function quoteString(text: string, ensureAscii: boolean): string {
  const pattern = ensureAscii ? ASCII_PRINTABLE_ONLY : CONTROL_AND_QUOTES;
  const escaped = text.replace(pattern, (character) =>
    SHORT_ESCAPES[character] ?? "\\u" + character.charCodeAt(0).toString(16).padStart(UNICODE_ESCAPE_WIDTH, "0"));
  return `"${escaped}"`;
}

export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Number.isInteger(value) && Math.abs(value) < 10 ** FLOAT_FIXED_LIMIT) {
    return Number.isSafeInteger(value) ? String(value) : `${value}.0`;
  }
  const [mantissa = "", exponentText = "0"] = value.toExponential().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const digits = mantissa.replace(/^-/, "").replace(".", "");
  const exponent = Number(exponentText);
  if (exponent < FLOAT_SMALL_LIMIT || exponent >= FLOAT_FIXED_LIMIT) {
    const fraction = digits.length > 1 ? "." + digits.slice(1) : "";
    const exponentSign = exponent < 0 ? "-" : "+";
    return `${sign}${digits[0]}${fraction}e${exponentSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent >= 0) {
    const whole = digits.padEnd(exponent + 1, "0");
    return `${sign}${whole.slice(0, exponent + 1)}.${whole.slice(exponent + 1) || "0"}`;
  }
  return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
}

export function pythonJsonDumps(value: JsonValue | undefined, options: DumpOptions = {}): string {
  const settings = { ensureAscii: true, sortKeys: false, ...options };
  const output: string[] = [];
  const pending: Array<string | { value: JsonValue; level: number }> = [{ value: value ?? null, level: 0 }];
  while (pending.length > 0) {
    const item = pending.pop() as string | { value: JsonValue; level: number };
    if (typeof item === "string") output.push(item);
    else for (const step of encodeStep(item.value, settings, item.level)) pending.push(step);
  }
  return output.join("");
}

function encodeStep(value: JsonValue, options: DumpOptions, level: number): Array<string | { value: JsonValue; level: number }> {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return [value ? "true" : "false"];
  if (typeof value === "bigint") return [value.toString()];
  if (typeof value === "number") return [pythonFloatRepr(value)];
  if (typeof value === "string") return [quoteString(value, options.ensureAscii ?? true)];
  const isArray = Array.isArray(value);
  let keys: string[] = [];
  if (!isArray) {
    keys = Object.keys(value).filter((key) => value[key] !== undefined);
    if (options.sortKeys) keys.sort(compareCodePoints);
  }
  const count = isArray ? value.length : keys.length;
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (count === 0) return [open + close];
  const inner = options.indent === undefined ? "" : "\n" + " ".repeat(options.indent * (level + 1));
  const separator = options.indent === undefined ? ", " : "," + inner;
  const outer = options.indent === undefined ? "" : "\n" + " ".repeat(options.indent * level);
  const steps: Array<string | { value: JsonValue; level: number }> = [open + inner];
  for (let position = 0; position < count; position += 1) {
    if (position > 0) steps.push(separator);
    if (isArray) steps.push({ value: value[position] as JsonValue, level: level + 1 });
    else {
      const key = keys[position] as string;
      steps.push(`${quoteString(key, options.ensureAscii ?? true)}: `, { value: (value as { [key: string]: JsonValue })[key] ?? null, level: level + 1 });
    }
  }
  steps.push(outer + close);
  return steps.reverse();
}
