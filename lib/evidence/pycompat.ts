import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getSystemErrorMap } from 'node:util';

const PYTHON_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_SPACE_CLASS = `[${PYTHON_SPACE}]`;
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const JSON_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const JSON_CONSTANTS: Array<[string, number | boolean | null]> = [
  ['null', null], ['true', true], ['false', false], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const PYTHON_SPACE_PATTERN = PYTHON_SPACE_CLASS;

export class JSONDecodeError extends Error {
  constructor(message: string, document: string[], position: number) {
    const before = document.slice(0, position);
    const lineNumber = before.filter((char) => char === '\n').length + 1;
    const lastNewline = before.lastIndexOf('\n');
    const column = lastNewline < 0 ? position + 1 : position - lastNewline;
    super(`${message}: line ${lineNumber} column ${column} (char ${position})`);
  }
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index++) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints);
}

export function pyStrip(value: string): string {
  return value.replace(new RegExp(`^${PYTHON_SPACE_CLASS}+|${PYTHON_SPACE_CLASS}+$`, 'g'), '');
}

export function pySplitWhitespace(value: string): string[] {
  return pyStrip(value) === '' ? [] : pyStrip(value).split(new RegExp(`${PYTHON_SPACE_CLASS}+`));
}

export function pySplitLines(value: string): string[] {
  const lines = value.split(LINE_BOUNDARY);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function decodeReplacing(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

export function decodeStrict(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function decodeSurrogateEscape(bytes: Uint8Array): string {
  let result = '';
  let index = 0;
  while (index < bytes.length) {
    const length = validSequenceLength(bytes, index);
    if (length === 0) {
      result += String.fromCharCode(0xdc00 + bytes[index]!);
      index++;
    } else {
      result += decodeReplacing(bytes.subarray(index, index + length));
      index += length;
    }
  }
  return result;
}

function validSequenceLength(bytes: Uint8Array, index: number): number {
  const lead = bytes[index]!;
  const continuation = (offset: number, low = 0x80, high = 0xbf) => {
    const byte = bytes[index + offset];
    return byte !== undefined && byte >= low && byte <= high;
  };
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return continuation(1) ? 2 : 0;
  if (lead >= 0xe0 && lead <= 0xef) {
    const second = lead === 0xe0 ? continuation(1, 0xa0) : lead === 0xed ? continuation(1, 0x80, 0x9f) : continuation(1);
    return second && continuation(2) ? 3 : 0;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    const second = lead === 0xf0 ? continuation(1, 0x90) : lead === 0xf4 ? continuation(1, 0x80, 0x8f) : continuation(1);
    return second && continuation(2) && continuation(3) ? 4 : 0;
  }
  return 0;
}

export function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let body = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === quote || char === '\\') body += '\\' + char;
    else if (char === '\n') body += '\\n';
    else if (char === '\r') body += '\\r';
    else if (char === '\t') body += '\\t';
    else if (code < 0x7f && code >= 0x20) body += char;
    else if (code > 0x7f && !NON_PRINTABLE.test(char)) body += char;
    else if (code <= 0xff) body += '\\x' + code.toString(16).padStart(2, '0');
    else if (code <= 0xffff) body += '\\u' + code.toString(16).padStart(4, '0');
    else body += '\\U' + code.toString(16).padStart(8, '0');
  }
  return quote + body + quote;
}

export function pyReprList(values: string[]): string {
  return '[' + values.map(pyRepr).join(', ') + ']';
}

export function pyOsErrorMessage(error: NodeJS.ErrnoException): string {
  const description = typeof error.errno === 'number' ? getSystemErrorMap().get(error.errno)?.[1] : undefined;
  if (description === undefined) return error.message;
  const text = description.charAt(0).toUpperCase() + description.slice(1);
  const where = error.path === undefined ? '' : `: ${pyRepr(error.path)}`;
  return `[Errno ${-error.errno!}] ${text}${where}`;
}

export function expandUser(path: string): string {
  if (!path.startsWith('~')) return path;
  const slash = path.indexOf('/', 1);
  const end = slash < 0 ? path.length : slash;
  if (end !== 1) return path;
  const configured = process.env['HOME'];
  const home = (configured ?? userInfo().homedir).replace(/\/+$/, '');
  return home + path.slice(end) || '/';
}

export function pythonJsonDumps(value: JsonValue | undefined, options: { sortKeys?: boolean } = {}): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return dumpNumber(value);
  if (typeof value === 'string') return dumpString(value);
  if (Array.isArray(value)) return '[' + value.map((item) => pythonJsonDumps(item, options)).join(', ') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = options.sortKeys ? sortedStrings(Object.keys(value)) : Object.keys(value);
    return '{' + keys.map((key) => dumpString(key) + ': ' + pythonJsonDumps(value[key], options)).join(', ') + '}';
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

function dumpNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return String(value);
}

function dumpString(value: string): string {
  let body = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const code = value.charCodeAt(index);
    if (char === '"') body += '\\"';
    else if (char === '\\') body += '\\\\';
    else if (char === '\n') body += '\\n';
    else if (char === '\r') body += '\\r';
    else if (char === '\t') body += '\\t';
    else if (char === '\b') body += '\\b';
    else if (char === '\f') body += '\\f';
    else if (code >= 0x20 && code <= 0x7e) body += char;
    else body += '\\u' + code.toString(16).padStart(4, '0');
  }
  return '"' + body + '"';
}

class StopScan extends Error {
  position: number;
  constructor(position: number) {
    super('stop');
    this.position = position;
  }
}

export function pythonJsonLoads(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return scanPythonJson(text);
  }
}

function scanPythonJson(text: string): JsonValue {
  const document = Array.from(text);
  if (document[0] === '\ufeff') throw new JSONDecodeError('Unexpected UTF-8 BOM (decode using utf-8-sig)', document, 0);
  const joined = (from: number, to: number) => document.slice(from, to).join('');
  const skipSpace = (position: number) => {
    while (position < document.length && JSON_WHITESPACE.has(document[position]!)) position++;
    return position;
  };

  const matchNumber = (position: number): string | null => {
    for (const width of [64, document.length - position]) {
      JSON_NUMBER.lastIndex = 0;
      const match = JSON_NUMBER.exec(joined(position, position + width));
      if (match === null) return null;
      if (match[0].length < width || width === document.length - position) return match[0];
    }
    return null;
  };

  const scanString = (begin: number): [string, number] => {
    let position = begin;
    let result = '';
    for (;;) {
      let chunkEnd = position;
      while (chunkEnd < document.length && document[chunkEnd] !== '"' && document[chunkEnd] !== '\\'
        && document[chunkEnd]!.codePointAt(0)! >= 0x20) chunkEnd++;
      result += joined(position, chunkEnd);
      position = chunkEnd;
      const terminator = document[position];
      if (terminator === undefined) throw new JSONDecodeError('Unterminated string starting at', document, begin - 1);
      if (terminator === '"') return [result, position + 1];
      if (terminator !== '\\') throw new JSONDecodeError('Invalid control character at', document, position);
      const escape = document[position + 1];
      if (escape === undefined) throw new JSONDecodeError('Unterminated string starting at', document, begin - 1);
      if (escape !== 'u') {
        const mapped = JSON_ESCAPES[escape];
        if (mapped === undefined) throw new JSONDecodeError('Invalid \\escape', document, position);
        result += mapped;
        position += 2;
        continue;
      }
      let unit = hexUnit(position + 2);
      position += 6;
      if (unit >= 0xd800 && unit <= 0xdbff && document[position] === '\\' && document[position + 1] === 'u') {
        const low = hexUnit(position + 2, true);
        if (low >= 0xdc00 && low <= 0xdfff) {
          unit = 0x10000 + (((unit - 0xd800) << 10) | (low - 0xdc00));
          position += 6;
        }
      }
      result += String.fromCodePoint(unit);
    }
  };

  const hexUnit = (start: number, quiet = false): number => {
    const digits = joined(start, start + 4);
    if (digits.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(digits)) {
      if (quiet) return -1;
      throw new JSONDecodeError('Invalid \\uXXXX escape', document, start - 1);
    }
    return parseInt(digits, 16);
  };

  const scanObject = (begin: number): [JsonValue, number] => {
    const result: { [key: string]: JsonValue } = {};
    let position = begin;
    let next = document[position];
    if (next !== '"') {
      position = skipSpace(position);
      next = document[position];
      if (next === '}') return [result, position + 1];
      if (next !== '"') throw new JSONDecodeError('Expecting property name enclosed in double quotes', document, position);
    }
    position++;
    for (;;) {
      const [key, afterKey] = scanString(position);
      position = afterKey;
      if (document[position] !== ':') {
        position = skipSpace(position);
        if (document[position] !== ':') throw new JSONDecodeError("Expecting ':' delimiter", document, position);
      }
      position = skipSpace(position + 1);
      const [value, afterValue] = scanValue(position);
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      position = skipSpace(afterValue);
      next = document[position];
      position++;
      if (next === '}') return [result, position];
      if (next !== ',') throw new JSONDecodeError("Expecting ',' delimiter", document, position - 1);
      const commaPosition = position - 1;
      position = skipSpace(position);
      next = document[position];
      position++;
      if (next !== '"') {
        if (next === '}') throw new JSONDecodeError('Illegal trailing comma before end of object', document, commaPosition);
        throw new JSONDecodeError('Expecting property name enclosed in double quotes', document, position - 1);
      }
    }
  };

  const scanArray = (begin: number): [JsonValue, number] => {
    const result: JsonValue[] = [];
    let position = skipSpace(begin);
    if (document[position] === ']') return [result, position + 1];
    for (;;) {
      const [value, afterValue] = scanValue(position);
      result.push(value);
      position = skipSpace(afterValue);
      const next = document[position];
      position++;
      if (next === ']') return [result, position];
      if (next !== ',') throw new JSONDecodeError("Expecting ',' delimiter", document, position - 1);
      const commaPosition = position - 1;
      position = skipSpace(position);
      if (document[position] === ']') throw new JSONDecodeError('Illegal trailing comma before end of array', document, commaPosition);
    }
  };

  const scanValue = (position: number): [JsonValue, number] => {
    try {
      return scanOnce(position);
    } catch (error) {
      if (error instanceof StopScan) throw new JSONDecodeError('Expecting value', document, error.position);
      throw error;
    }
  };

  const scanOnce = (position: number): [JsonValue, number] => {
    const char = document[position];
    if (char === undefined) throw new StopScan(position);
    if (char === '"') return scanString(position + 1);
    if (char === '{') return scanObject(position + 1);
    if (char === '[') return scanArray(position + 1);
    const rest = joined(position, position + 9);
    for (const [name, value] of JSON_CONSTANTS) {
      if (rest.startsWith(name)) return [value, position + name.length];
    }
    const match = matchNumber(position);
    if (match === null) throw new StopScan(position);
    return [Number(match), position + match.length];
  };

  const start = skipSpace(0);
  let value: JsonValue;
  let end: number;
  try {
    [value, end] = scanOnce(start);
  } catch (error) {
    if (error instanceof StopScan) throw new JSONDecodeError('Expecting value', document, error.position);
    throw error;
  }
  end = skipSpace(end);
  if (end !== document.length) throw new JSONDecodeError('Extra data', document, end);
  return value;
}

const FNMATCH_SPECIALS = new Set('\\^$.*+?()[]{}|/'.split(''));

export function fnmatchCase(name: string, pattern: string): boolean {
  return new RegExp(`^(?:${fnmatchRegex(pattern)})$`, 'su').test(name);
}

function fnmatchRegex(pattern: string): string {
  const chars = Array.from(pattern);
  let result = '';
  let index = 0;
  while (index < chars.length) {
    const char = chars[index++]!;
    if (char === '*') {
      result += '.*';
      while (chars[index] === '*') index++;
    } else if (char === '?') {
      result += '.';
    } else if (char === '[') {
      const [piece, next] = bracketExpression(chars, index);
      result += piece;
      index = next;
    } else {
      result += FNMATCH_SPECIALS.has(char) ? '\\' + char : char;
    }
  }
  return result;
}

function bracketExpression(chars: string[], start: number): [string, number] {
  let close = start;
  if (chars[close] === '!') close++;
  if (chars[close] === ']') close++;
  while (close < chars.length && chars[close] !== ']') close++;
  if (close >= chars.length) return ['\\[', start];
  const negated = chars[start] === '!';
  const members = classMembers(chars.slice(start + (negated ? 1 : 0), close));
  const next = close + 1;
  if (members === '') return [negated ? '.' : '(?!)', next];
  return [`[${negated ? '^' : ''}${members}]`, next];
}

function classMembers(chars: string[]): string {
  const chunks: string[][] = [];
  let from = 0;
  let searchFrom = 1;
  for (;;) {
    const hyphen = chars.indexOf('-', searchFrom);
    if (hyphen < 0) break;
    chunks.push(chars.slice(from, hyphen));
    from = hyphen + 1;
    searchFrom = hyphen + 3;
  }
  const last = chars.slice(from);
  if (last.length > 0) chunks.push(last);
  else if (chunks.length > 0) chunks[chunks.length - 1]!.push('-');
  else return '';
  for (let index = chunks.length - 1; index > 0; index--) {
    const before = chunks[index - 1]!;
    const after = chunks[index]!;
    if (compareCodePoints(before.at(-1)!, after[0]!) > 0) {
      chunks[index - 1] = [...before.slice(0, -1), ...after.slice(1)];
      chunks.splice(index, 1);
    }
  }
  return chunks.map((chunk) => chunk.map(escapeClassChar).join('')).join('-');
}

function escapeClassChar(char: string): string {
  return '\\^]-['.includes(char) ? '\\' + char : char;
}

export function pyRealpath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

const ERRNO_EXCEPTION_NAMES: Record<string, string> = {
  ENOENT: 'FileNotFoundError', EACCES: 'PermissionError', EPERM: 'PermissionError', EEXIST: 'FileExistsError',
  EISDIR: 'IsADirectoryError', ENOTDIR: 'NotADirectoryError', ETIMEDOUT: 'TimeoutError',
};

export function pythonErrnoName(code: string | undefined): string {
  return (code !== undefined && ERRNO_EXCEPTION_NAMES[code]) || 'OSError';
}
