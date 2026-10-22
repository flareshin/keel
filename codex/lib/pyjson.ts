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

function scanValue(text: string, index: number): [JsonValue, number] {
  const character = text[index];
  if (character === '"') return scanString(text, index);
  if (character === "{") return scanObject(text, index + 1);
  if (character === "[") return scanArray(text, index + 1);
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

function scanArray(text: string, start: number): [JsonValue[], number] {
  const items: JsonValue[] = [];
  let index = skipWhitespace(text, start);
  if (text[index] === "]") return [items, index + 1];
  for (;;) {
    const [value, end] = scanValue(text, index);
    items.push(value);
    index = skipWhitespace(text, end);
    if (text[index] === "]") return [items, index + 1];
    if (text[index] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", text, index);
    const comma = index;
    index = skipWhitespace(text, index + 1);
    if (text[index] === "]") throw new JSONDecodeError("Illegal trailing comma before end of array", text, comma);
  }
}

function scanObject(text: string, start: number): [{ [key: string]: JsonValue }, number] {
  const members: { [key: string]: JsonValue } = {};
  let index = skipWhitespace(text, start);
  if (text[index] === "}") return [members, index + 1];
  for (;;) {
    if (text[index] !== '"') throw new JSONDecodeError("Expecting property name enclosed in double quotes", text, index);
    const [key, afterKey] = scanString(text, index);
    index = skipWhitespace(text, afterKey);
    if (text[index] !== ":") throw new JSONDecodeError("Expecting ':' delimiter", text, index);
    const [value, afterValue] = scanValue(text, skipWhitespace(text, index + 1));
    Object.defineProperty(members, key, { value, enumerable: true, writable: true, configurable: true });
    index = skipWhitespace(text, afterValue);
    if (text[index] === "}") return [members, index + 1];
    if (text[index] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", text, index);
    const comma = index;
    index = skipWhitespace(text, index + 1);
    if (text[index] === "}") throw new JSONDecodeError("Illegal trailing comma before end of object", text, comma);
  }
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
  return encode(value ?? null, { ensureAscii: true, sortKeys: false, ...options }, 0);
}

function encode(value: JsonValue, options: DumpOptions, level: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return pythonFloatRepr(value);
  if (typeof value === "string") return quoteString(value, options.ensureAscii ?? true);
  if (Array.isArray(value)) return wrap("[", "]", value.map((item) => encode(item, options, level + 1)), options, level);
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (options.sortKeys) keys.sort(compareCodePoints);
  const members = keys.map((key) => `${quoteString(key, options.ensureAscii ?? true)}: ${encode(value[key] ?? null, options, level + 1)}`);
  return wrap("{", "}", members, options, level);
}

function wrap(open: string, close: string, items: readonly string[], options: DumpOptions, level: number): string {
  if (items.length === 0) return open + close;
  if (options.indent === undefined) return open + items.join(", ") + close;
  const inner = "\n" + " ".repeat(options.indent * (level + 1));
  return open + inner + items.join("," + inner) + "\n" + " ".repeat(options.indent * level) + close;
}
