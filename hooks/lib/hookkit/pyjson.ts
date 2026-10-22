import { codePointLength, isRecord, pythonJsonDumps } from "./pycompat.ts";
import { ValueError } from "./pyruntime.ts";

const JSON_WHITESPACE = " \t\n\r";
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;
const NON_FINITE_LITERALS: ReadonlyMap<string, number> = new Map([["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]]);
const KEYWORD_LITERALS: ReadonlyMap<string, null | boolean> = new Map([["null", null], ["true", true], ["false", false]]);
const BYTE_ORDER_MARK = "﻿";

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

class Document {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    const parsed = this.value(this.skipWhitespace(0));
    const end = this.skipWhitespace(parsed.end);
    if (end !== this.text.length) throw new SyntaxProblem("Extra data", end);
    return parsed.value;
  }

  private skipWhitespace(position: number): number {
    let end = position;
    while (end < this.text.length && JSON_WHITESPACE.includes(this.text[end] ?? "")) end += 1;
    return end;
  }

  private value(start: number): Parsed {
    const first = this.text[start];
    if (first === '"') return this.stringValue(start);
    if (first === "{") return this.object(start + 1);
    if (first === "[") return this.array(start + 1);
    for (const [literal, value] of KEYWORD_LITERALS) if (this.text.startsWith(literal, start)) return { value, end: start + literal.length };
    NUMBER.lastIndex = start;
    const number = NUMBER.exec(this.text);
    if (number) return { value: JSON.parse(number[0]), end: start + number[0].length };
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

  private object(afterBrace: number): Parsed {
    const members: Record<string, unknown> = {};
    let position = this.skipWhitespace(afterBrace);
    if (this.text[position] === "}") return { value: members, end: position + 1 };
    if (this.text[position] !== '"') throw new SyntaxProblem("Expecting property name enclosed in double quotes", position);
    for (;;) {
      const key = this.stringValue(position);
      position = this.skipWhitespace(key.end);
      if (this.text[position] !== ":") throw new SyntaxProblem("Expecting ':' delimiter", position);
      const member = this.value(this.skipWhitespace(position + 1));
      Object.defineProperty(members, key.value as string, { value: member.value, enumerable: true, writable: true, configurable: true });
      position = this.skipWhitespace(member.end);
      const separator = this.text[position];
      if (separator === "}") return { value: members, end: position + 1 };
      if (separator !== ",") throw new SyntaxProblem("Expecting ',' delimiter", position);
      const comma = position;
      position = this.skipWhitespace(position + 1);
      if (this.text[position] === '"') continue;
      if (this.text[position] === "}") throw new SyntaxProblem("Illegal trailing comma before end of object", comma);
      throw new SyntaxProblem("Expecting property name enclosed in double quotes", position);
    }
  }

  private array(afterBracket: number): Parsed {
    const items: unknown[] = [];
    let position = this.skipWhitespace(afterBracket);
    if (this.text[position] === "]") return { value: items, end: position + 1 };
    for (;;) {
      const item = this.value(position);
      items.push(item.value);
      position = this.skipWhitespace(item.end);
      const separator = this.text[position];
      if (separator === "]") return { value: items, end: position + 1 };
      if (separator !== ",") throw new SyntaxProblem("Expecting ',' delimiter", position);
      const comma = position;
      position = this.skipWhitespace(position + 1);
      if (this.text[position] === "]") throw new SyntaxProblem("Illegal trailing comma before end of array", comma);
    }
  }
}

const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/g;

export function dumpsAscii(value: unknown): string {
  return pythonJsonDumps(value).replace(NOT_PRINTABLE_ASCII, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
