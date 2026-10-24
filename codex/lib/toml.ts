import { codePointLength } from "../../hooks/lib/hookkit/pycompat.ts";
import { Refusal } from "./refusal.ts";

export type TomlTable = Map<string, TomlValue>;
export type TomlValue = string | bigint | number | boolean | TomlTemporal | TomlValue[] | TomlTable;
type Key = readonly string[];

export class TomlTemporal {
  readonly kind: "date" | "time" | "datetime";
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;
  readonly offsetMinutes: number | null;

  constructor(kind: "date" | "time" | "datetime", fields: Partial<Omit<TomlTemporal, "kind">>) {
    this.kind = kind;
    this.year = fields.year ?? 0;
    this.month = fields.month ?? 0;
    this.day = fields.day ?? 0;
    this.hour = fields.hour ?? 0;
    this.minute = fields.minute ?? 0;
    this.second = fields.second ?? 0;
    this.microsecond = fields.microsecond ?? 0;
    this.offsetMinutes = fields.offsetMinutes ?? null;
  }
}

export class TOMLDecodeError extends Refusal {
  constructor(message: string, text: string, position: number) {
    super(`${message} (at ${describePosition(text, position)})`);
    this.name = "TOMLDecodeError";
  }
}

class NestError extends Error {}

export class RecursionError extends Error {
  constructor() {
    super("maximum recursion depth exceeded");
    this.name = "RecursionError";
  }
}

const PYTHON_RECURSION_LIMIT = 1000;
const FRAMES_FROM_LOADS_TO_KEY_VALUE_PAIR = 2;
const ARRAY_LEAF_FRAMES = 2;
const INLINE_TABLE_LEAF_FRAMES = 4;
const LAZY_REGEX_IMPORT_FRAMES = 22;

let scalarPatternsLoaded = false;

function describePosition(text: string, position: number): string {
  if (position >= text.length) return "end of document";
  const before = text.slice(0, position);
  const lineStart = before.lastIndexOf("\n");
  const line = before.split("\n").length;
  const column = codePointLength(lineStart < 0 ? before : before.slice(lineStart + 1)) + 1;
  return `line ${line}, column ${column}`;
}

const FROZEN = 0;
const EXPLICIT_NEST = 1;
const DECIMAL_DIGIT_LIMIT = 4300;
const MICROSECOND_DIGITS = 6;
const LAST_VALID_YEAR = 9999;
const WHITESPACE = new Set([" ", "\t"]);
const WHITESPACE_AND_NEWLINE = new Set([" ", "\t", "\n"]);
const BARE_KEY_CHARACTERS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_");
const KEY_INITIAL_CHARACTERS = new Set([...BARE_KEY_CHARACTERS, '"', "'"]);
const HEX_DIGITS = /^[0-9a-fA-F]*$/;
const ESCAPE_REPLACEMENTS: Record<string, string> = {
  "\\b": "\b", "\\t": "\t", "\\n": "\n", "\\f": "\f", "\\r": "\r", "\\e": "\x1b", '\\"': '"', "\\\\": "\\",
};
const TIME_SOURCE = String.raw`([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,6})[0-9]*)?)?`;
const LOCAL_TIME = new RegExp(TIME_SOURCE, "y");
const DATE_TIME = new RegExp(
  String.raw`([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(?:[Tt ]${TIME_SOURCE}(?:([Zz])|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))?)?`, "y");
const NUMBER = new RegExp(
  String.raw`0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|b[01](?:_?[01])*|o[0-7](?:_?[0-7])*)|` +
  String.raw`[+-]?(?:0|[1-9](?:_?[0-9])*)(?<floatpart>(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?)`, "y");

function isAsciiControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function isIllegalInString(character: string, allowNewline: boolean): boolean {
  return isAsciiControl(character) && character !== "\t" && !(allowNewline && character === "\n");
}

function keyRepr(key: Key): string {
  return key.map((part) => JSON.stringify(part)).join(".");
}

interface FlagNode {
  flags: Set<number>;
  recursiveFlags: Set<number>;
  nested: Map<string, FlagNode>;
}

class Flags {
  private readonly root = new Map<string, FlagNode>();
  private pending: Array<[Key, number]> = [];

  addPending(key: Key, flag: number): void {
    this.pending.push([key, flag]);
  }

  finalizePending(): void {
    for (const [key, flag] of this.pending) this.set(key, flag, false);
    this.pending = [];
  }

  unsetAll(key: Key): void {
    let container = this.root;
    for (const part of key.slice(0, -1)) {
      const node = container.get(part);
      if (node === undefined) return;
      container = node.nested;
    }
    container.delete(key[key.length - 1] ?? "");
  }

  set(key: Key, flag: number, recursive: boolean): void {
    let container = this.root;
    for (const part of key.slice(0, -1)) container = ensureNode(container, part).nested;
    const node = ensureNode(container, key[key.length - 1] ?? "");
    (recursive ? node.recursiveFlags : node.flags).add(flag);
  }

  is(key: Key, flag: number): boolean {
    if (key.length === 0) return false;
    let container = this.root;
    for (const part of key.slice(0, -1)) {
      const node = container.get(part);
      if (node === undefined) return false;
      if (node.recursiveFlags.has(flag)) return true;
      container = node.nested;
    }
    const stem = container.get(key[key.length - 1] ?? "");
    return stem !== undefined && (stem.flags.has(flag) || stem.recursiveFlags.has(flag));
  }
}

function ensureNode(container: Map<string, FlagNode>, part: string): FlagNode {
  let node = container.get(part);
  if (node === undefined) {
    node = { flags: new Set(), recursiveFlags: new Set(), nested: new Map() };
    container.set(part, node);
  }
  return node;
}

class NestedTable {
  readonly table: TomlTable = new Map();

  getOrCreateNest(key: Key, accessLists = true): TomlTable {
    let container: TomlValue | undefined = this.table;
    for (const part of key) {
      const parent: TomlTable = container as TomlTable;
      if (!parent.has(part)) parent.set(part, new Map());
      container = parent.get(part);
      if (accessLists && Array.isArray(container)) container = container[container.length - 1];
      if (!(container instanceof Map)) throw new NestError("There is no nest behind this key");
    }
    return container as TomlTable;
  }

  appendNestToList(key: Key): void {
    const container = this.getOrCreateNest(key.slice(0, -1));
    const last = key[key.length - 1] ?? "";
    const tableArray = container.get(last);
    if (tableArray === undefined) container.set(last, [new Map()]);
    else if (Array.isArray(tableArray)) tableArray.push(new Map());
    else throw new NestError("An object other than list found behind this key");
  }
}

interface Output {
  data: NestedTable;
  flags: Flags;
}

export function tomlLoads(text: string, callerFrames = 0): TomlTable {
  const source = text.replaceAll("\r\n", "\n");
  const out: Output = { data: new NestedTable(), flags: new Flags() };
  let header: Key = [];
  let position = 0;
  for (;;) {
    position = skipChars(source, position, WHITESPACE);
    const character = source[position];
    if (character === undefined) break;
    if (character === "\n") {
      position += 1;
      continue;
    }
    if (KEY_INITIAL_CHARACTERS.has(character)) {
      position = keyValueRule(source, position, out, header, callerFrames + 1 + FRAMES_FROM_LOADS_TO_KEY_VALUE_PAIR);
      position = skipChars(source, position, WHITESPACE);
    } else if (character === "[") {
      out.flags.finalizePending();
      [position, header] = source[position + 1] === "[" ? createListRule(source, position, out) : createTableRule(source, position, out);
      position = skipChars(source, position, WHITESPACE);
    } else if (character !== "#") {
      throw new TOMLDecodeError("Invalid statement", source, position);
    }
    position = skipComment(source, position);
    const end = source[position];
    if (end === undefined) break;
    if (end !== "\n") throw new TOMLDecodeError("Expected newline or end of document after a statement", source, position);
    position += 1;
  }
  return out.data.table;
}

function loadScalarPatterns(frame: number): void {
  if (scalarPatternsLoaded) return;
  requireFrames(frame + LAZY_REGEX_IMPORT_FRAMES);
  scalarPatternsLoaded = true;
}

function requireFrames(deepest: number): void {
  if (deepest > PYTHON_RECURSION_LIMIT) throw new RecursionError();
}

function skipChars(source: string, start: number, characters: ReadonlySet<string>): number {
  let position = start;
  while (position < source.length && characters.has(source[position] ?? "")) position += 1;
  return position;
}

function skipUntil(source: string, start: number, expect: string, allowNewline: boolean, errorOnEof: boolean): number {
  let end = source.indexOf(expect, start);
  if (end < 0) {
    end = source.length;
    if (errorOnEof) throw new TOMLDecodeError(`Expected ${JSON.stringify(expect)}`, source, end);
  }
  for (let position = start; position < end; position += 1) {
    const character = source[position] ?? "";
    if (isIllegalInString(character, allowNewline)) {
      throw new TOMLDecodeError(`Found invalid character ${JSON.stringify(character)}`, source, position);
    }
  }
  return end;
}

function skipComment(source: string, position: number): number {
  return source[position] === "#" ? skipUntil(source, position + 1, "\n", false, false) : position;
}

function skipCommentsAndArrayWhitespace(source: string, start: number): number {
  let position = start;
  for (;;) {
    const before = position;
    position = skipComment(source, skipChars(source, position, WHITESPACE_AND_NEWLINE));
    if (position === before) return position;
  }
}

function createTableRule(source: string, start: number, out: Output): [number, Key] {
  const [position, key] = parseKey(source, skipChars(source, start + 1, WHITESPACE));
  if (out.flags.is(key, EXPLICIT_NEST) || out.flags.is(key, FROZEN)) {
    throw new TOMLDecodeError(`Cannot declare ${keyRepr(key)} twice`, source, position);
  }
  out.flags.set(key, EXPLICIT_NEST, false);
  nestOrFail(source, position, () => out.data.getOrCreateNest(key));
  if (!source.startsWith("]", position)) throw new TOMLDecodeError("Expected ']' at the end of a table declaration", source, position);
  return [position + 1, key];
}

function createListRule(source: string, start: number, out: Output): [number, Key] {
  const [position, key] = parseKey(source, skipChars(source, start + 2, WHITESPACE));
  if (out.flags.is(key, FROZEN)) throw new TOMLDecodeError(`Cannot mutate immutable namespace ${keyRepr(key)}`, source, position);
  out.flags.unsetAll(key);
  out.flags.set(key, EXPLICIT_NEST, false);
  nestOrFail(source, position, () => out.data.appendNestToList(key));
  if (!source.startsWith("]]", position)) throw new TOMLDecodeError("Expected ']]' at the end of an array declaration", source, position);
  return [position + 2, key];
}

function nestOrFail<T>(source: string, position: number, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof NestError) throw new TOMLDecodeError("Cannot overwrite a value", source, position);
    throw error;
  }
}

function keyValueRule(source: string, start: number, out: Output, header: Key, frame: number): number {
  const [position, key, value] = parseKeyValuePair(source, start, frame);
  const parent = key.slice(0, -1);
  const stem = key[key.length - 1] ?? "";
  const absoluteParent = [...header, ...parent];
  for (let length = 1; length < key.length; length += 1) {
    const container = [...header, ...key.slice(0, length)];
    if (out.flags.is(container, EXPLICIT_NEST)) throw new TOMLDecodeError(`Cannot redefine namespace ${keyRepr(container)}`, source, position);
    out.flags.addPending(container, EXPLICIT_NEST);
  }
  if (out.flags.is(absoluteParent, FROZEN)) {
    throw new TOMLDecodeError(`Cannot mutate immutable namespace ${keyRepr(absoluteParent)}`, source, position);
  }
  const nest = nestOrFail(source, position, () => out.data.getOrCreateNest(absoluteParent));
  if (nest.has(stem)) throw new TOMLDecodeError("Cannot overwrite a value", source, position);
  if (value instanceof Map || Array.isArray(value)) out.flags.set([...header, ...key], FROZEN, true);
  nest.set(stem, value);
  return position;
}

function parseKeyValuePair(source: string, start: number, frame: number): [number, Key, TomlValue] {
  const [afterKey, key] = parseKey(source, start);
  if (source[afterKey] !== "=") throw new TOMLDecodeError("Expected '=' after a key in a key/value pair", source, afterKey);
  const [position, value] = parseValue(source, skipChars(source, afterKey + 1, WHITESPACE), frame + 1);
  return [position, key, value];
}

function parseKey(source: string, start: number): [number, Key] {
  let [position, part] = parseKeyPart(source, start);
  const key = [part];
  position = skipChars(source, position, WHITESPACE);
  while (source[position] === ".") {
    [position, part] = parseKeyPart(source, skipChars(source, position + 1, WHITESPACE));
    key.push(part);
    position = skipChars(source, position, WHITESPACE);
  }
  return [position, key];
}

function parseKeyPart(source: string, position: number): [number, string] {
  const character = source[position];
  if (character !== undefined && BARE_KEY_CHARACTERS.has(character)) {
    const end = skipChars(source, position, BARE_KEY_CHARACTERS);
    return [end, source.slice(position, end)];
  }
  if (character === "'") return parseLiteralString(source, position);
  if (character === '"') return parseBasicString(source, position + 1, false);
  throw new TOMLDecodeError("Invalid initial character for a key part", source, position);
}

function parseArray(source: string, start: number, frame: number): [number, TomlValue[]] {
  requireFrames(frame + ARRAY_LEAF_FRAMES);
  const array: TomlValue[] = [];
  let position = skipCommentsAndArrayWhitespace(source, start + 1);
  if (source.startsWith("]", position)) return [position + 1, array];
  for (;;) {
    let value: TomlValue;
    [position, value] = parseValue(source, position, frame + 1);
    array.push(value);
    position = skipCommentsAndArrayWhitespace(source, position);
    const character = source.slice(position, position + 1);
    if (character === "]") return [position + 1, array];
    if (character !== ",") throw new TOMLDecodeError("Unclosed array", source, position);
    position = skipCommentsAndArrayWhitespace(source, position + 1);
    if (source.startsWith("]", position)) return [position + 1, array];
  }
}

function parseInlineTable(source: string, start: number, frame: number): [number, TomlTable] {
  requireFrames(frame + INLINE_TABLE_LEAF_FRAMES);
  const nested = new NestedTable();
  const flags = new Flags();
  let position = skipCommentsAndArrayWhitespace(source, start + 1);
  if (source.startsWith("}", position)) return [position + 1, nested.table];
  for (;;) {
    let key: Key;
    let value: TomlValue;
    [position, key, value] = parseKeyValuePair(source, position, frame + 1);
    const stem = key[key.length - 1] ?? "";
    if (flags.is(key, FROZEN)) throw new TOMLDecodeError(`Cannot mutate immutable namespace ${keyRepr(key)}`, source, position);
    const nest = nestOrFail(source, position, () => nested.getOrCreateNest(key.slice(0, -1), false));
    if (nest.has(stem)) throw new TOMLDecodeError(`Duplicate inline table key ${JSON.stringify(stem)}`, source, position);
    nest.set(stem, value);
    position = skipCommentsAndArrayWhitespace(source, position);
    const character = source.slice(position, position + 1);
    if (character === "}") return [position + 1, nested.table];
    if (character !== ",") throw new TOMLDecodeError("Unclosed inline table", source, position);
    position = skipCommentsAndArrayWhitespace(source, position + 1);
    if (source.startsWith("}", position)) return [position + 1, nested.table];
    if (value instanceof Map || Array.isArray(value)) flags.set(key, FROZEN, true);
  }
}

function parseEscape(source: string, start: number, multiline: boolean): [number, string] {
  const escape = source.slice(start, start + 2);
  let position = start + 2;
  if (multiline && (escape === "\\ " || escape === "\\\t" || escape === "\\\n")) {
    if (escape !== "\\\n") {
      position = skipChars(source, position, WHITESPACE);
      const character = source[position];
      if (character === undefined) return [position, ""];
      if (character !== "\n") throw new TOMLDecodeError("Unescaped '\\' in a string", source, position);
      position += 1;
    }
    return [skipChars(source, position, WHITESPACE_AND_NEWLINE), ""];
  }
  if (escape === "\\x") return parseHexCharacter(source, position, 2);
  if (escape === "\\u") return parseHexCharacter(source, position, 4);
  if (escape === "\\U") return parseHexCharacter(source, position, 8);
  const replacement = Object.hasOwn(ESCAPE_REPLACEMENTS, escape) ? ESCAPE_REPLACEMENTS[escape] : undefined;
  if (replacement === undefined) throw new TOMLDecodeError("Unescaped '\\' in a string", source, position);
  return [position, replacement];
}

function parseHexCharacter(source: string, start: number, length: number): [number, string] {
  const digits = source.slice(start, start + length);
  if (digits.length !== length || !HEX_DIGITS.test(digits)) throw new TOMLDecodeError("Invalid hex value", source, start);
  const position = start + length;
  const code = parseInt(digits, 16);
  if (!((code >= 0 && code <= 55295) || (code >= 57344 && code <= 1114111))) {
    throw new TOMLDecodeError("Escaped character is not a Unicode scalar value", source, position);
  }
  return [position, String.fromCodePoint(code)];
}

function parseLiteralString(source: string, start: number): [number, string] {
  const end = skipUntil(source, start + 1, "'", false, true);
  return [end + 1, source.slice(start + 1, end)];
}

function parseMultilineString(source: string, start: number, literal: boolean): [number, string] {
  let position = start + 3;
  if (source.startsWith("\n", position)) position += 1;
  let multilineText: string;
  const delimiter = literal ? "'" : '"';
  if (literal) {
    const end = skipUntil(source, position, "'''", true, true);
    multilineText = source.slice(position, end);
    position = end + 3;
  } else {
    [position, multilineText] = parseBasicString(source, position, true);
  }
  if (!source.startsWith(delimiter, position)) return [position, multilineText];
  position += 1;
  if (!source.startsWith(delimiter, position)) return [position, multilineText + delimiter];
  return [position + 1, multilineText + delimiter.repeat(2)];
}

function parseBasicString(source: string, start: number, multiline: boolean): [number, string] {
  let parsedText = "";
  let position = start;
  let chunkStart = start;
  for (;;) {
    const character = source[position];
    if (character === undefined) throw new TOMLDecodeError("Unterminated string", source, position);
    if (character === '"') {
      if (!multiline) return [position + 1, parsedText + source.slice(chunkStart, position)];
      if (source.startsWith('"""', position)) return [position + 3, parsedText + source.slice(chunkStart, position)];
      position += 1;
    } else if (character === "\\") {
      parsedText += source.slice(chunkStart, position);
      let parsed: string;
      [position, parsed] = parseEscape(source, position, multiline);
      parsedText += parsed;
      chunkStart = position;
    } else if (isIllegalInString(character, multiline)) {
      throw new TOMLDecodeError(`Illegal character ${JSON.stringify(character)}`, source, position);
    } else {
      position += 1;
    }
  }
}

function parseValue(source: string, position: number, frame: number): [number, TomlValue] {
  const character = source[position];
  if (character === '"') {
    return source.startsWith('"""', position) ? parseMultilineString(source, position, false) : parseBasicString(source, position + 1, false);
  }
  if (character === "'") {
    return source.startsWith("'''", position) ? parseMultilineString(source, position, true) : parseLiteralString(source, position);
  }
  if (character === "t" && source.startsWith("true", position)) return [position + 4, true];
  if (character === "f" && source.startsWith("false", position)) return [position + 5, false];
  if (character === "[") return parseArray(source, position, frame + 1);
  if (character === "{") return parseInlineTable(source, position, frame + 1);
  loadScalarPatterns(frame);
  DATE_TIME.lastIndex = position;
  const dateTime = DATE_TIME.exec(source);
  if (dateTime !== null) return [position + dateTime[0].length, temporalFromMatch(dateTime, source, position)];
  LOCAL_TIME.lastIndex = position;
  const localTime = LOCAL_TIME.exec(source);
  if (localTime !== null) return [position + localTime[0].length, localTimeFromMatch(localTime)];
  NUMBER.lastIndex = position;
  const number = NUMBER.exec(source);
  if (number !== null) return [position + number[0].length, numberFromMatch(number)];
  const three = source.slice(position, position + 3);
  if (three === "inf" || three === "nan") return [position + 3, three === "inf" ? Infinity : NaN];
  const four = source.slice(position, position + 4);
  if (four === "-inf" || four === "+inf") return [position + 4, four === "-inf" ? -Infinity : Infinity];
  if (four === "-nan" || four === "+nan") return [position + 4, NaN];
  throw new TOMLDecodeError("Invalid value", source, position);
}

function microseconds(digits: string | undefined): number {
  return digits === undefined ? 0 : Number(digits.padEnd(MICROSECOND_DIGITS, "0"));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function temporalFromMatch(match: RegExpExecArray, source: string, position: number): TomlTemporal {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zulu, sign, offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || year > LAST_VALID_YEAR || day > daysInMonth(year, month)) {
    throw new TOMLDecodeError("Invalid date or datetime", source, position);
  }
  if (hourText === undefined) return new TomlTemporal("date", { year, month, day });
  const offsetMinutes = sign ? (sign === "+" ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute)) : zulu ? 0 : null;
  return new TomlTemporal("datetime", {
    year, month, day, hour: Number(hourText), minute: Number(minuteText), second: Number(secondText ?? 0),
    microsecond: microseconds(fraction), offsetMinutes,
  });
}

function localTimeFromMatch(match: RegExpExecArray): TomlTemporal {
  const [, hour, minute, second, fraction] = match;
  return new TomlTemporal("time", { hour: Number(hour), minute: Number(minute), second: Number(second ?? 0), microsecond: microseconds(fraction) });
}

function numberFromMatch(match: RegExpExecArray): bigint | number {
  const text = match[0].replaceAll("_", "");
  if (match.groups?.["floatpart"]) return Number(text);
  const digits = /^[+-]?[0-9]+$/.test(text) ? text.replace(/^[+-]/, "").length : 0;
  if (digits > DECIMAL_DIGIT_LIMIT) {
    throw new Refusal(`Exceeds the limit (${DECIMAL_DIGIT_LIMIT} digits) for integer string conversion: value has ${digits} digits; ` +
      "use sys.set_int_max_str_digits() to increase the limit");
  }
  return BigInt(text);
}

const MICROSECONDS_PER_MINUTE = 60_000_000n;

function epochMicroseconds(value: TomlTemporal): bigint {
  const shifted = value.month <= 2 ? value.year - 1 : value.year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (value.month + (value.month > 2 ? -3 : 9)) + 2) / 5) + value.day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = BigInt(era * 146097 + dayOfEra);
  const seconds = days * 86400n + BigInt(value.hour * 3600 + value.minute * 60 + value.second);
  return seconds * 1_000_000n + BigInt(value.microsecond) - BigInt(value.offsetMinutes ?? 0) * MICROSECONDS_PER_MINUTE;
}

function temporalEquals(left: TomlTemporal, right: TomlTemporal): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "datetime" && (left.offsetMinutes === null) !== (right.offsetMinutes === null)) return false;
  if (left.kind === "datetime" && left.offsetMinutes !== null) return epochMicroseconds(left) === epochMicroseconds(right);
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour &&
    left.minute === right.minute && left.second === right.second && left.microsecond === right.microsecond;
}

function numericValue(value: TomlValue): bigint | number | null {
  if (typeof value === "boolean") return value ? 1n : 0n;
  return typeof value === "bigint" || typeof value === "number" ? value : null;
}

function numbersEqual(left: bigint | number, right: bigint | number): boolean {
  if (typeof left === "bigint" && typeof right === "bigint") return left === right;
  if (typeof left === "number" && typeof right === "number") return left === right;
  const [whole, fractional] = typeof left === "bigint" ? [left, right as number] : [right as bigint, left];
  return Number.isInteger(fractional) && BigInt(fractional) === whole;
}

export function tomlEquals(left: TomlValue, right: TomlValue): boolean {
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  if (leftNumber !== null || rightNumber !== null) return leftNumber !== null && rightNumber !== null && numbersEqual(leftNumber, rightNumber);
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left instanceof TomlTemporal || right instanceof TomlTemporal) {
    return left instanceof TomlTemporal && right instanceof TomlTemporal && temporalEquals(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => tomlEquals(item, right[index] as TomlValue));
  }
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  for (const [key, item] of left) {
    const other = right.get(key);
    if (other === undefined || !tomlEquals(item, other)) return false;
  }
  return true;
}
