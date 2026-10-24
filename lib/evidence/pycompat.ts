import { getSystemErrorMap } from 'node:util';

export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type JsonValue = null | boolean | number | bigint | string | PyFloat | JsonValue[] | { [key: string]: JsonValue };

const PYTHON_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_SPACE_CLASS = `[${PYTHON_SPACE}]`;
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const INTEGER_DIGIT_LIMIT = 4300;
const MAX_JSON_DEPTH = 10000;
const OVER_LIMIT_DIGITS = new RegExp(`[0-9]{${INTEGER_DIGIT_LIMIT + 1}}`);
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const JSON_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const JSON_CONSTANTS: Array<[string, JsonValue]> = [
  ['null', null], ['true', true], ['false', false],
  ['NaN', new PyFloat(NaN)], ['Infinity', new PyFloat(Infinity)], ['-Infinity', new PyFloat(-Infinity)],
];

export class ValueError extends Error {}

export class RecursionError extends Error {}

export class JSONDecodeError extends ValueError {
  constructor(message: string, document: string[], position: number) {
    const before = document.slice(0, position);
    const lineNumber = before.filter((char) => char === '\n').length + 1;
    const lastNewline = before.lastIndexOf('\n');
    const column = lastNewline < 0 ? position + 1 : position - lastNewline;
    super(`${message}: line ${lineNumber} column ${column} (char ${position})`);
  }
}

function compareCodePoints(left: string, right: string): number {
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

export class UnicodeDecodeError extends Error {}

export function decodeStrict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new UnicodeDecodeError(utf8FailureMessage(bytes));
  }
}

function utf8FailureMessage(bytes: Uint8Array): string {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index]!;
    const length = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (length === 0) return utf8Failure(bytes, index, index + 1, 'invalid start byte');
    for (let offset = 1; offset < length; offset++) {
      const byte = bytes[index + offset];
      if (byte === undefined) return utf8Failure(bytes, index, bytes.length, 'unexpected end of data');
      const low = offset === 1 ? (lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80) : 0x80;
      const high = offset === 1 ? (lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf) : 0xbf;
      if (byte < low || byte > high) return utf8Failure(bytes, index, index + offset, 'invalid continuation byte');
    }
    index += length;
  }
  return 'invalid utf-8';
}

function utf8Failure(bytes: Uint8Array, start: number, end: number, reason: string): string {
  if (end - start === 1) {
    return `'utf-8' codec can't decode byte 0x${bytes[start]!.toString(16).padStart(2, '0')} in position ${start}: ${reason}`;
  }
  return `'utf-8' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`;
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

const OS_WORDING: Record<string, string> = {
  EALREADY: 'Operation already in progress', EEXIST: 'File exists', EFAULT: 'Bad address', EHOSTUNREACH: 'No route to host',
  EIO: 'Input/output error', EISDIR: 'Is a directory', ELOOP: 'Too many levels of symbolic links', ENAMETOOLONG: 'File name too long',
  ENFILE: 'Too many open files in system', ENOMEM: 'Cannot allocate memory', ENOTSUP: 'Operation not supported', ESPIPE: 'Illegal seek',
  ETXTBSY: 'Text file busy',
};
const OS_WORDING_BY_PLATFORM: Record<string, Record<string, string>> = {
  darwin: {
    EADDRNOTAVAIL: "Can't assign requested address", EAFNOSUPPORT: 'Address family not supported by protocol family',
    EBUSY: 'Resource busy', ENODATA: 'No message available on STREAM', ENODEV: 'Operation not supported by device',
    ENXIO: 'Device not configured', EOVERFLOW: 'Value too large to be stored in data type', ETIMEDOUT: 'Operation timed out',
    EXDEV: 'Cross-device link',
  },
  unverifiedGlibc: {
    EADDRNOTAVAIL: 'Cannot assign requested address', EAFNOSUPPORT: 'Address family not supported by protocol',
    EBUSY: 'Device or resource busy', ENODATA: 'No data available', ENODEV: 'No such device', ENXIO: 'No such device or address',
    EOVERFLOW: 'Value too large for defined data type', ETIMEDOUT: 'Connection timed out', EXDEV: 'Invalid cross-device link',
  },
};

function osWording(code: string | undefined, libuvDescription: string): string {
  const platformWording = OS_WORDING_BY_PLATFORM[process.platform === 'darwin' ? 'darwin' : 'unverifiedGlibc']!;
  const wording = code === undefined ? undefined : OS_WORDING[code] ?? platformWording[code];
  return wording ?? libuvDescription.charAt(0).toUpperCase() + libuvDescription.slice(1);
}

function pyOsErrorMessage(error: NodeJS.ErrnoException): string {
  const description = typeof error.errno === 'number' ? getSystemErrorMap().get(error.errno)?.[1] : undefined;
  if (description === undefined) return error.message;
  const text = osWording(error.code, description);
  const where = error.path === undefined ? '' : `: ${pyRepr(error.path)}`;
  return `[Errno ${-error.errno!}] ${text}${where}`;
}

interface OpenDump {
  closer: string;
  items: Array<JsonValue | undefined>;
  keys: string[] | null;
  index: number;
}

export function pythonJsonDumps(value: JsonValue | undefined, options: { sortKeys?: boolean } = {}): string {
  const parts: string[] = [];
  const open: OpenDump[] = [];
  let next = value;
  for (;;) {
    if (Array.isArray(next) || isJsonObject(next)) {
      if (open.length >= MAX_JSON_DEPTH) throw new RecursionError('maximum recursion depth exceeded while encoding a JSON object');
      const keys = Array.isArray(next) ? null : options.sortKeys ? sortedStrings(Object.keys(next)) : Object.keys(next);
      const items = Array.isArray(next) ? next : keys!.map((key) => (next as { [key: string]: JsonValue })[key]);
      const opener = keys === null ? '[' : '{';
      const closer = keys === null ? ']' : '}';
      if (items.length > 0) {
        open.push({ closer, items, keys, index: 0 });
        parts.push(opener + dumpMemberKey(keys, 0));
        next = items[0];
        continue;
      }
      parts.push(opener + closer);
    } else {
      parts.push(dumpScalar(next));
    }
    const following = closeFinishedDumps(open, parts);
    if (following === null) return parts.join('');
    next = following.value;
  }
}

function closeFinishedDumps(open: OpenDump[], parts: string[]): { value: JsonValue | undefined } | null {
  for (;;) {
    const innermost = open.at(-1);
    if (innermost === undefined) return null;
    innermost.index += 1;
    if (innermost.index < innermost.items.length) {
      parts.push(', ' + dumpMemberKey(innermost.keys, innermost.index));
      return { value: innermost.items[innermost.index] };
    }
    parts.push(innermost.closer);
    open.pop();
  }
}

function dumpMemberKey(keys: string[] | null, index: number): string {
  return keys === null ? '' : dumpString(keys[index]!) + ': ';
}

function dumpScalar(value: JsonValue | undefined): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : dumpFloat(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof PyFloat) return dumpFloat(value.value);
  if (typeof value === 'string') return dumpString(value);
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

function dumpFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  return pyFloatRepr(value);
}

const EXPONENT_FORM = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/;
const FIRST_EXPONENT_FORM_DECIMAL_POINT = -4;
const LAST_PLAIN_DECIMAL_POINT = 16;

function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const parts = EXPONENT_FORM.exec(value.toExponential());
  if (!parts) throw new Error(`unexpected exponent form of ${value}`);
  const [, sign = '', first = '', rest = '', exponentText = '0'] = parts;
  const digits = first + rest;
  const exponent = Number(exponentText);
  const decimalPoint = exponent + 1;
  if (decimalPoint <= FIRST_EXPONENT_FORM_DECIMAL_POINT || decimalPoint > LAST_PLAIN_DECIMAL_POINT) {
    const mantissa = rest ? `${first}.${rest}` : first;
    return `${sign}${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (decimalPoint <= 0) return `${sign}0.${'0'.repeat(-decimalPoint)}${digits}`;
  if (decimalPoint >= digits.length) return `${sign}${digits}${'0'.repeat(decimalPoint - digits.length)}.0`;
  return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
}

function jsonNumber(source: string): number | bigint | PyFloat {
  if (/[.eE]/.test(source)) return new PyFloat(Number(source));
  const digits = source.length - (source.startsWith('-') ? 1 : 0);
  if (digits > INTEGER_DIGIT_LIMIT) {
    throw new ValueError(`Exceeds the limit (${INTEGER_DIGIT_LIMIT} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  const value = Number(source);
  return Number.isSafeInteger(value) ? value + 0 : BigInt(source);
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

type OpenContainer =
  | { kind: 'array'; items: JsonValue[] }
  | { kind: 'object'; members: { [key: string]: JsonValue }; key: string };

function reviveNumber(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' ? jsonNumber(context!.source!) : value;
}

export function pythonJsonLoads(text: string): JsonValue {
  if (!OVER_LIMIT_DIGITS.test(text)) {
    try {
      return JSON.parse(text, reviveNumber) as JsonValue;
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof RangeError)) throw error;
    }
  }
  return scanPythonJson(text);
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
    let decoded = '';
    for (;;) {
      let chunkEnd = position;
      while (chunkEnd < document.length && document[chunkEnd] !== '"' && document[chunkEnd] !== '\\'
        && document[chunkEnd]!.codePointAt(0)! >= 0x20) chunkEnd++;
      decoded += joined(position, chunkEnd);
      position = chunkEnd;
      const terminator = document[position];
      if (terminator === undefined) throw new JSONDecodeError('Unterminated string starting at', document, begin - 1);
      if (terminator === '"') return [decoded, position + 1];
      if (terminator !== '\\') throw new JSONDecodeError('Invalid control character at', document, position);
      const escape = document[position + 1];
      if (escape === undefined) throw new JSONDecodeError('Unterminated string starting at', document, begin - 1);
      if (escape !== 'u') {
        const mapped = JSON_ESCAPES[escape];
        if (mapped === undefined) throw new JSONDecodeError('Invalid \\escape', document, position);
        decoded += mapped;
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
      decoded += String.fromCodePoint(unit);
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

  const scanKey = (begin: number): [string, number] => {
    const [key, afterKey] = scanString(begin);
    let position = afterKey;
    if (document[position] !== ':') {
      position = skipSpace(position);
      if (document[position] !== ':') throw new JSONDecodeError("Expecting ':' delimiter", document, position);
    }
    return [key, skipSpace(position + 1)];
  };

  const scanScalar = (position: number): [JsonValue, number] => {
    const char = document[position];
    if (char === undefined) throw new JSONDecodeError('Expecting value', document, position);
    if (char === '"') return scanString(position + 1);
    const rest = joined(position, position + 9);
    for (const [name, value] of JSON_CONSTANTS) {
      if (rest.startsWith(name)) return [value, position + name.length];
    }
    const match = matchNumber(position);
    if (match === null) throw new JSONDecodeError('Expecting value', document, position);
    return [jsonNumber(match), position + match.length];
  };

  const scanDocument = (start: number): [JsonValue, number] => {
    const open: OpenContainer[] = [];
    let position = start;
    for (;;) {
      let value: JsonValue;
      const char = document[position];
      if ((char === '[' || char === '{') && open.length >= MAX_JSON_DEPTH) {
        throw new RecursionError(`maximum recursion depth exceeded while decoding a JSON ${char === '[' ? 'array' : 'object'} from a unicode string`);
      }
      if (char === '[') {
        position = skipSpace(position + 1);
        if (document[position] !== ']') {
          open.push({ kind: 'array', items: [] });
          continue;
        }
        value = [];
        position++;
      } else if (char === '{') {
        const first = skipSpace(position + 1);
        if (document[first] === '}') {
          value = {};
          position = first + 1;
        } else if (document[first] === '"') {
          const [key, afterKey] = scanKey(first + 1);
          open.push({ kind: 'object', members: {}, key });
          position = afterKey;
          continue;
        } else {
          throw new JSONDecodeError('Expecting property name enclosed in double quotes', document, first);
        }
      } else {
        [value, position] = scanScalar(position);
      }
      for (;;) {
        const container = open.at(-1);
        if (container === undefined) return [value, position];
        if (container.kind === 'array') {
          container.items.push(value);
        } else {
          Object.defineProperty(container.members, container.key, { value, enumerable: true, writable: true, configurable: true });
        }
        const closer = container.kind === 'array' ? ']' : '}';
        position = skipSpace(position);
        const next = document[position];
        position++;
        if (next === closer) {
          value = container.kind === 'array' ? container.items : container.members;
          open.pop();
          continue;
        }
        if (next !== ',') throw new JSONDecodeError("Expecting ',' delimiter", document, position - 1);
        const commaPosition = position - 1;
        position = skipSpace(position);
        if (container.kind === 'array') {
          if (document[position] === ']') throw new JSONDecodeError('Illegal trailing comma before end of array', document, commaPosition);
          break;
        }
        const nextKey = document[position];
        position++;
        if (nextKey !== '"') {
          if (nextKey === '}') throw new JSONDecodeError('Illegal trailing comma before end of object', document, commaPosition);
          throw new JSONDecodeError('Expecting property name enclosed in double quotes', document, position - 1);
        }
        [container.key, position] = scanKey(position);
        break;
      }
    }
  };

  const [value, afterValue] = scanDocument(skipSpace(0));
  const end = skipSpace(afterValue);
  if (end !== document.length) throw new JSONDecodeError('Extra data', document, end);
  return value;
}

export function isJsonObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof PyFloat);
}

export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || value === '') return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isJsonObject(value)) return Object.keys(value).length > 0;
  return true;
}

export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  return '[unrepresentable]';
}

const ERRNO_EXCEPTION_NAMES: Record<string, string> = {
  ENOENT: 'FileNotFoundError', EACCES: 'PermissionError', EPERM: 'PermissionError', EEXIST: 'FileExistsError',
  EISDIR: 'IsADirectoryError', ENOTDIR: 'NotADirectoryError', ETIMEDOUT: 'TimeoutError',
};

function pythonErrnoName(code: string | undefined): string {
  return (code !== undefined && ERRNO_EXCEPTION_NAMES[code]) || 'OSError';
}

export function pythonTypeName(error: unknown): string {
  if (error instanceof JSONDecodeError) return 'JSONDecodeError';
  if (error instanceof Error) {
    const named = (error as { pythonName?: string }).pythonName;
    if (named) return named;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof (error as NodeJS.ErrnoException).errno === 'number') return pythonErrnoName(code);
    return error.constructor.name;
  }
  return typeof error;
}

export function errorText(error: unknown): string {
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).errno === 'number') {
    return pyOsErrorMessage(error as NodeJS.ErrnoException);
  }
  return error instanceof Error ? error.message : String(error);
}
