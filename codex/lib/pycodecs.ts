import { TextDecoder } from "node:util";
import { ValueError } from "./pyerrors.ts";
import { decodeFailure, decodeUtf8Handling, escapedBytes } from "./pyfs.ts";

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
  euc_kr: ["cseuckr", "euckr", "x_mac_korean"],
  euc_jp: ["cseucpkdfmtjapanese", "eucjp", "u_jis", "ujis"],
  shift_jis: ["csshiftjis", "s_jis", "shiftjis", "sjis", "x_mac_japanese"],
  big5: ["big5_tw", "csbig5", "x_mac_trad_chinese"],
  gbk: ["936", "cp936", "csgbk", "ms936", "windows_936"],
  gb2312: ["chinese", "csgb2312", "csiso58gb231280", "euc_cn", "euccn", "eucgb2312_cn", "gb2312_1980", "gb2312_80", "gb_2312_80", "iso_ir_58", "x_mac_simp_chinese"],
};

const WHATWG_LABELS: Record<string, string> = {
  cp1252: "windows-1252", cp1251: "windows-1251", cp866: "ibm866", koi8_r: "koi8-r", iso8859_2: "iso-8859-2", iso8859_5: "iso-8859-5",
  iso8859_7: "iso-8859-7", iso8859_15: "iso-8859-15", euc_kr: "euc-kr", euc_jp: "euc-jp", shift_jis: "shift_jis", big5: "big5", gbk: "gbk", gb2312: "gbk",
};

const UNDEFINED_BYTES: Record<string, readonly number[]> = { cp1252: [0x81, 0x8d, 0x8f, 0x90, 0x9d], cp1251: [0x98] };
const MULTI_BYTE_REJECTED: Record<string, readonly number[]> = {
  euc_kr: [...range(0x80, 0x8d), ...range(0x90, 0x9f)], euc_jp: [...range(0x80, 0x8d), ...range(0x90, 0x9f)], big5: [0x80, 0xff], gbk: [0x80], gb2312: [0x80],
};
const INCOMPLETE_SEQUENCE = "incomplete multibyte sequence";
const ILLEGAL_SEQUENCE = "illegal multibyte sequence";
const MULTI_BYTE = new Set(["euc_kr", "euc_jp", "shift_jis", "big5", "gbk", "gb2312"]);
const ASCII_LIMIT = 0x80;
const REPLACEMENT_CHARACTER = "�";
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const SURROGATE_LEAD = 0xed;
const FIRST_SURROGATE_SECOND_BYTE = 0xa0;
const FIRST_CONTINUATION = 0x80;
const LAST_CONTINUATION = 0xbf;
const ENCODED_SURROGATE_BASE = 0xd000;
const ENCODED_SURROGATE_LENGTH = 3;
const CONTINUATION_PAYLOAD = 0x3f;
const BYTE_VALUES = 256;

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_unused, offset) => first + offset);
}

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

export function canonicalCodec(name: string): string | null {
  return canonicalByName.get(normalizeCodecName(name)) ?? null;
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
    default: throw new Error(`stdin error handler ${errors} aborts Python with an uncaught exception`);
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

interface MultiByteFailure {
  start: number;
  end: number;
  reason: string;
}

function locateMultiByteFailure(canonical: string, bytes: Buffer): MultiByteFailure | null {
  const decoder = new TextDecoder(WHATWG_LABELS[canonical] as string, { fatal: true });
  const rejected = MULTI_BYTE_REJECTED[canonical] ?? [];
  let pending = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const last = index === bytes.length - 1;
    try {
      if (rejected.includes(bytes[index] ?? 0)) throw new Error("byte Python rejects");
      pending = decoder.decode(bytes.subarray(index, index + 1), { stream: true }) === "" ? pending + 1 : 0;
    } catch {
      const start = index - pending;
      return { start, end: start + 1, reason: last && pending === 0 ? INCOMPLETE_SEQUENCE : ILLEGAL_SEQUENCE };
    }
  }
  try {
    decoder.decode();
    return null;
  } catch {
    return { start: bytes.length - Math.max(pending, 1), end: bytes.length, reason: INCOMPLETE_SEQUENCE };
  }
}

function decodeMultiByte(canonical: string, bytes: Buffer, errors: string): string {
  const label = WHATWG_LABELS[canonical] as string;
  let text = "";
  let from = 0;
  for (;;) {
    const rest = bytes.subarray(from);
    const failure = locateMultiByteFailure(canonical, rest);
    if (failure === null) return text + new TextDecoder(label).decode(rest);
    const [start, end] = [from + failure.start, from + failure.end];
    text += new TextDecoder(label).decode(bytes.subarray(from, start));
    text += handleFailure(errors, bytes, start, end, () => {
      const where = end - start === 1 ? `byte ${hexByte(bytes[start])} in position ${start}` : `bytes in position ${start}-${end - 1}`;
      return `'${canonical}' codec can't decode ${where}: ${failure.reason}`;
    });
    from = end;
  }
}

export function decodeWithCodec(canonical: string, bytes: Buffer, errors: string): string {
  if (canonical === "latin_1") return bytes.toString("latin1");
  if (canonical === "utf_8") return decodeUtf8(bytes, errors);
  if (canonical === "utf_8_sig") return decodeUtf8WithSignature(bytes, errors);
  if (canonical === "ascii") {
    const table = Array.from({ length: BYTE_VALUES }, (_unused, byte) => (byte < ASCII_LIMIT ? String.fromCharCode(byte) : null));
    return decodeByTable(bytes, errors, table, (position) => `'ascii' codec can't decode byte ${hexByte(bytes[position])} in position ${position}: ordinal not in range(128)`);
  }
  if (MULTI_BYTE.has(canonical)) return decodeMultiByte(canonical, bytes, errors);
  return decodeByTable(bytes, errors, singleByteTable(canonical), (position) =>
    `'charmap' codec can't decode byte ${hexByte(bytes[position])} in position ${position}: character maps to <undefined>`);
}
