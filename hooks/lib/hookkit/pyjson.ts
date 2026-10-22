import { codePointLength, isRecord, pythonJsonDumps } from "./pycompat.ts";
import { ValueError } from "./pyruntime.ts";

const JSON_WHITESPACE = " \t\n\r";
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;
const NON_FINITE_LITERALS: ReadonlyMap<string, number> = new Map([["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]]);
const KEYWORD_LITERALS: ReadonlyMap<string, null | boolean> = new Map([["null", null], ["true", true], ["false", false]]);
const BYTE_ORDER_MARK = "﻿";
const INTEGER_DIGIT_LIMIT = 4300;

export class JSONDecodeError extends ValueError {
  override name = "JSONDecodeError";
}

class SyntaxProblem extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

export function parsePayload(raw: string): Record<string, unknown> {
  const payload = loads(raw);
  if (!isRecord(payload)) throw new ValueError("hook payload is not a JSON object");
  return payload;
}

export function loads(text: string): unknown {
  if (text.startsWith(BYTE_ORDER_MARK)) throw decodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  try {
    return new Document(text).parse();
  } catch (error) {
    if (error instanceof SyntaxProblem) throw decodeError(error.message, text, error.position);
    throw error;
  }
}

function decodeError(message: string, text: string, position: number): JSONDecodeError {
  const before = text.slice(0, position);
  const lineNumber = before.split("\n").length;
  const column = codePointLength(before.slice(before.lastIndexOf("\n") + 1)) + 1;
  return new JSONDecodeError(`${message}: line ${lineNumber} column ${column} (char ${codePointLength(before)})`);
}

interface Parsed {
  value: unknown;
  end: number;
}

type OpenContainer =
  | { kind: "array"; items: unknown[] }
  | { kind: "object"; members: Record<string, unknown>; key: string };

interface ContainerStep {
  closed: boolean;
  position: number;
}

class Document {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    const parsed = this.scanDocument(this.skipWhitespace(0));
    const end = this.skipWhitespace(parsed.end);
    if (end !== this.text.length) throw new SyntaxProblem("Extra data", end);
    return parsed.value;
  }

  private skipWhitespace(position: number): number {
    let end = position;
    while (end < this.text.length && JSON_WHITESPACE.includes(this.text[end] ?? "")) end += 1;
    return end;
  }

  private scanDocument(start: number): Parsed {
    const open: OpenContainer[] = [];
    let position = start;
    for (;;) {
      let value: unknown;
      const first = this.text[position];
      if (first === "[") {
        position = this.skipWhitespace(position + 1);
        if (this.text[position] !== "]") {
          open.push({ kind: "array", items: [] });
          continue;
        }
        value = [];
        position += 1;
      } else if (first === "{") {
        const keyStart = this.skipWhitespace(position + 1);
        if (this.text[keyStart] === "}") {
          value = {};
          position = keyStart + 1;
        } else if (this.text[keyStart] === '"') {
          const key = this.scanKey(keyStart);
          open.push({ kind: "object", members: {}, key: key.name });
          position = key.valueStart;
          continue;
        } else {
          throw new SyntaxProblem("Expecting property name enclosed in double quotes", keyStart);
        }
      } else {
        ({ value, end: position } = this.scanScalar(position));
      }
      for (;;) {
        const container = open.at(-1);
        if (container === undefined) return { value, end: position };
        addMember(container, value);
        const step = this.stepInContainer(container, position);
        position = step.position;
        if (!step.closed) break;
        value = container.kind === "array" ? container.items : container.members;
        open.pop();
      }
    }
  }

  private stepInContainer(container: OpenContainer, afterValue: number): ContainerStep {
    const closer = container.kind === "array" ? "]" : "}";
    let position = this.skipWhitespace(afterValue);
    const separator = this.text[position];
    if (separator === closer) return { closed: true, position: position + 1 };
    if (separator !== ",") throw new SyntaxProblem("Expecting ',' delimiter", position);
    const comma = position;
    position = this.skipWhitespace(position + 1);
    if (container.kind === "array") {
      if (this.text[position] === "]") throw new SyntaxProblem("Illegal trailing comma before end of array", comma);
      return { closed: false, position };
    }
    if (this.text[position] === "}") throw new SyntaxProblem("Illegal trailing comma before end of object", comma);
    if (this.text[position] !== '"') throw new SyntaxProblem("Expecting property name enclosed in double quotes", position);
    const key = this.scanKey(position);
    container.key = key.name;
    return { closed: false, position: key.valueStart };
  }

  private scanKey(quote: number): { name: string; valueStart: number } {
    const name = this.stringValue(quote);
    const colon = this.skipWhitespace(name.end);
    if (this.text[colon] !== ":") throw new SyntaxProblem("Expecting ':' delimiter", colon);
    return { name: name.value as string, valueStart: this.skipWhitespace(colon + 1) };
  }

  private scanScalar(start: number): Parsed {
    if (this.text[start] === '"') return this.stringValue(start);
    for (const [literal, value] of KEYWORD_LITERALS) if (this.text.startsWith(literal, start)) return { value, end: start + literal.length };
    NUMBER.lastIndex = start;
    const number = NUMBER.exec(this.text);
    if (number) return { value: parseNumber(number[0]), end: start + number[0].length };
    for (const [literal, value] of NON_FINITE_LITERALS) if (this.text.startsWith(literal, start)) return { value, end: start + literal.length };
    throw new SyntaxProblem("Expecting value", start);
  }

  private stringValue(quote: number): Parsed {
    const end = this.string(quote + 1);
    return { value: JSON.parse(this.text.slice(quote, end)), end };
  }

  private string(contentStart: number): number {
    const begin = contentStart - 1;
    let position = contentStart;
    for (;;) {
      const character = this.text[position];
      if (character === undefined) throw new SyntaxProblem("Unterminated string starting at", begin);
      if (character === '"') return position + 1;
      if (character < " ") throw new SyntaxProblem("Invalid control character at", position);
      if (character !== "\\") {
        position += 1;
        continue;
      }
      const escape = this.text[position + 1];
      if (escape === undefined) throw new SyntaxProblem("Unterminated string starting at", begin);
      if (escape !== "u") {
        if (!'"\\/bfnrt'.includes(escape)) throw new SyntaxProblem("Invalid \\escape", position);
        position += 2;
        continue;
      }
      position = this.unicodeEscape(position + 1);
    }
  }

  private unicodeEscape(letterPosition: number): number {
    const code = this.hexQuad(letterPosition);
    const afterFirst = letterPosition + 5;
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (isHighSurrogate && this.text.startsWith("\\u", afterFirst)) {
      const second = this.hexQuad(afterFirst + 1);
      if (second >= 0xdc00 && second <= 0xdfff) return afterFirst + 6;
    }
    return afterFirst;
  }

  private hexQuad(letterPosition: number): number {
    const digits = this.text.slice(letterPosition + 1, letterPosition + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) throw new SyntaxProblem("Invalid \\uXXXX escape", letterPosition);
    return parseInt(digits, 16);
  }
}

function addMember(container: OpenContainer, value: unknown): void {
  if (container.kind === "array") container.items.push(value);
  else Object.defineProperty(container.members, container.key, { value, enumerable: true, writable: true, configurable: true });
}

function parseNumber(source: string): number {
  const digits = source.length - (source.startsWith("-") ? 1 : 0);
  if (!/[.eE]/.test(source) && digits > INTEGER_DIGIT_LIMIT) {
    throw new ValueError(`Exceeds the limit (${INTEGER_DIGIT_LIMIT} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  return JSON.parse(source);
}

const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/g;

export function dumpsAscii(value: unknown): string {
  return pythonJsonDumps(value).replace(NOT_PRINTABLE_ASCII, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
