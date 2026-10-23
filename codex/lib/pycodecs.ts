import { TextDecoder } from "node:util";
import { ValueError } from "./pyerrors.ts";
import { ASCII_LIMIT, decodeFailure, decodeUtf8Handling, escapedBytes } from "./pyfs.ts";
import { NON_TEXT_ENCODINGS, PYTHON_CODEC_ALIAS_NAMES, TEXT_ENCODING_NAMES } from "./pycodec_names.ts";

const ALIASES: Record<string, readonly string[]> = {
  utf_8: ["cp65001", "csutf8", "u8", "utf", "utf8", "utf8_ucs2", "utf8_ucs4"],
  utf_8_sig: ["utf8_sig"],
  ascii: ["646", "ansi_x3.4_1968", "ansi_x3.4_1986", "ansi_x3_4_1968", "cp367", "csascii", "ibm367", "iso646_us", "iso_646.irv_1991", "iso_ir_6", "us", "us_ascii"],
  latin_1: ["8859", "cp819", "csisolatin1", "ibm819", "iso8859", "iso8859_1", "iso_8859_1", "iso_8859_1_1987", "iso_ir_100", "l1", "latin", "latin1"],
  cp1252: ["1252", "cswindows1252", "windows_1252"],
  cp1251: ["1251", "cswindows1251", "windows_1251"],
  cp866: ["866", "csibm866", "ibm866"],
  koi8_r: ["cskoi8r"],
  iso8859_2: ["csisolatin2", "iso_8859_2", "iso_8859_2_1987", "iso_ir_101", "l2", "latin2", "latin_2"],
  iso8859_5: ["csisolatincyrillic", "cyrillic", "iso_8859_5", "iso_8859_5_1988", "iso_ir_144"],
  iso8859_7: ["csisolatingreek", "ecma_118", "elot_928", "greek", "greek8", "iso_8859_7", "iso_8859_7_1987", "iso_ir_126"],
  iso8859_15: ["csiso885915", "iso_8859_15", "l9", "latin9", "latin_9"],
};

const WHATWG_LABELS: Record<string, string> = {
  cp1252: "windows-1252", cp1251: "windows-1251", cp866: "ibm866", koi8_r: "koi8-r", iso8859_2: "iso-8859-2", iso8859_5: "iso-8859-5",
  iso8859_7: "iso-8859-7", iso8859_15: "iso-8859-15",
};

const UNDEFINED_BYTES: Record<string, readonly number[]> = { cp1252: [0x81, 0x8d, 0x8f, 0x90, 0x9d], cp1251: [0x98] };
const REPLACEMENT_CHARACTER = "�";
export const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const SURROGATE_LEAD = 0xed;
const FIRST_SURROGATE_SECOND_BYTE = 0xa0;
const FIRST_CONTINUATION = 0x80;
const LAST_CONTINUATION = 0xbf;
const ENCODED_SURROGATE_BASE = 0xd000;
const ENCODED_SURROGATE_LENGTH = 3;
const CONTINUATION_PAYLOAD = 0x3f;
const BYTE_VALUES = 256;

const canonicalByName = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(ALIASES)) {
  canonicalByName.set(canonical, canonical);
  for (const alias of aliases) canonicalByName.set(alias, canonical);
}

const singleByteTables = new Map<string, Array<string | null>>();

export function normalizeCodecName(name: string): string {
  let normalized = "";
  let separated = false;
  for (const character of name) {
    if (/[\p{L}\p{N}.]/u.test(character)) {
      if (separated && normalized !== "") normalized += "_";
      if (character.charCodeAt(0) < ASCII_LIMIT) normalized += character;
      separated = false;
    } else {
      separated = true;
    }
  }
  return normalized.toLowerCase();
}

export class PythonStartupFailure extends Error {
  readonly stderr: string;

  constructor(header: string, detail: string, runtimeState: "core initialized" | "preinitializing" = "core initialized") {
    super(detail || header);
    this.name = "PythonStartupFailure";
    this.stderr = runtimeState === "preinitializing"
      ? `Fatal Python error: ${header}\nPython runtime state: preinitializing\n\n`
      : `Fatal Python error: ${header}\nPython runtime state: core initialized\n${detail}\n\nCurrent thread 0x0000000000000000 (most recent call first):\n`;
  }
}

export class PythonUncaughtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonUncaughtError";
  }
}

export class UnsupportedStdinEncoding extends ValueError {
  constructor(name: string) {
    super(`stdin encoding ${name} is not supported; set PYTHONUTF8=1`);
    this.name = "UnsupportedStdinEncoding";
  }
}

export type StdinEncoding = { kind: "exact"; codec: string } | { kind: "unsupported"; name: string };

const textNames = new Set(TEXT_ENCODING_NAMES);
const aliasNames = new Set(PYTHON_CODEC_ALIAS_NAMES);

function lookupKeys(name: string): string[] {
  const normalized = normalizeCodecName(name);
  const dottedAlias = normalized.replaceAll(".", "_");
  return aliasNames.has(dottedAlias) ? [normalized, dottedAlias] : [normalized];
}

export function canonicalCodec(name: string): string | null {
  for (const key of lookupKeys(name)) {
    const codec = canonicalByName.get(key);
    if (codec !== undefined) return codec;
  }
  return null;
}

export function resolveStdinEncoding(name: string): StdinEncoding {
  for (const key of lookupKeys(name)) {
    const codec = canonicalByName.get(key);
    if (codec !== undefined) return { kind: "exact", codec };
    if (textNames.has(key)) return { kind: "unsupported", name: key };
    if (Object.hasOwn(NON_TEXT_ENCODINGS, key)) {
      throw new PythonStartupFailure("init_sys_streams: can't initialize sys standard streams", `LookupError: '${NON_TEXT_ENCODINGS[key]}' is not a text encoding`);
    }
  }
  throw new PythonStartupFailure("init_stdio_encoding: failed to get the Python codec name of the stdio encoding", `LookupError: unknown encoding: ${name}`);
}

function handleFailure(errors: string, bytes: Buffer, start: number, end: number, message: () => string): string {
  switch (errors) {
    case "strict":
    case "surrogatepass":
      throw new ValueError(message());
    case "surrogateescape":
      if (bytes.subarray(start, end).some((byte) => byte < ASCII_LIMIT)) throw new ValueError(message());
      return escapedBytes(bytes, start, end);
    case "replace": return REPLACEMENT_CHARACTER;
    case "ignore": return "";
    case "backslashreplace": return Array.from(bytes.subarray(start, end), (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
    default: throw new PythonUncaughtError(`stdin error handler ${errors} aborts Python with an uncaught exception`);
  }
}

function encodedSurrogateAt(bytes: Buffer, start: number): string | null {
  const [lead, second, third] = [bytes[start], bytes[start + 1], bytes[start + 2]];
  if (lead !== SURROGATE_LEAD || second === undefined || third === undefined) return null;
  if (second < FIRST_SURROGATE_SECOND_BYTE || second > LAST_CONTINUATION || third < FIRST_CONTINUATION || third > LAST_CONTINUATION) return null;
  return String.fromCharCode(ENCODED_SURROGATE_BASE + ((second & CONTINUATION_PAYLOAD) << 6) + (third & CONTINUATION_PAYLOAD));
}

function decodeUtf8(bytes: Buffer, errors: string): string {
  return decodeUtf8Handling(bytes, (problem) => {
    const surrogate = errors === "surrogatepass" ? encodedSurrogateAt(bytes, problem.start) : null;
    if (surrogate !== null) return { text: surrogate, resumeAt: problem.start + ENCODED_SURROGATE_LENGTH };
    return handleFailure(errors, bytes, problem.start, problem.end, () => decodeFailure(bytes, problem));
  });
}

function decodeUtf8WithSignature(bytes: Buffer, errors: string): string {
  const signed = UTF8_BOM.every((byte, index) => bytes[index] === byte);
  return decodeUtf8(signed ? bytes.subarray(UTF8_BOM.length) : bytes, errors);
}

function hexByte(byte: number | undefined): string {
  return `0x${(byte ?? 0).toString(16).padStart(2, "0")}`;
}

function decodeByTable(bytes: Buffer, errors: string, table: ReadonlyArray<string | null>, undefinedMessage: (position: number) => string): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const character = table[bytes[index] ?? 0] ?? null;
    text += character ?? handleFailure(errors, bytes, index, index + 1, () => undefinedMessage(index));
  }
  return text;
}

function decodedOrNull(decoder: TextDecoder, byte: number): string | null {
  try {
    return decoder.decode(Uint8Array.of(byte));
  } catch {
    return null;
  }
}

function singleByteTable(canonical: string): Array<string | null> {
  const known = singleByteTables.get(canonical);
  if (known !== undefined) return known;
  const unmapped = new Set(UNDEFINED_BYTES[canonical] ?? []);
  const decoder = new TextDecoder(WHATWG_LABELS[canonical] as string, { fatal: true });
  const table = Array.from({ length: BYTE_VALUES }, (_unused, byte) => (unmapped.has(byte) ? null : decodedOrNull(decoder, byte)));
  singleByteTables.set(canonical, table);
  return table;
}

export function decodeWithCodec(canonical: string, bytes: Buffer, errors: string): string {
  if (canonical === "latin_1") return bytes.toString("latin1");
  if (canonical === "utf_8") return decodeUtf8(bytes, errors);
  if (canonical === "utf_8_sig") return decodeUtf8WithSignature(bytes, errors);
  if (canonical === "ascii") {
    const table = Array.from({ length: BYTE_VALUES }, (_unused, byte) => (byte < ASCII_LIMIT ? String.fromCharCode(byte) : null));
    return decodeByTable(bytes, errors, table, (position) => `'ascii' codec can't decode byte ${hexByte(bytes[position])} in position ${position}: ordinal not in range(128)`);
  }
  return decodeByTable(bytes, errors, singleByteTable(canonical), (position) =>
    `'charmap' codec can't decode byte ${hexByte(bytes[position])} in position ${position}: character maps to <undefined>`);
}
