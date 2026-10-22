import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ValueError } from "./pyerrors.ts";
import { decodeFailure, utf8Problem } from "./pyfs.ts";
import type { Utf8Problem } from "./pyfs.ts";

export interface StdinCodec {
  encoding: "utf-8" | "ascii" | "latin-1";
  errors: string;
}

const DARWIN_LOCALE_ROOT = "/usr/share/locale";
const ASCII_LIMIT = 0x80;
const SURROGATE_ESCAPE_BASE = 0xdc00;
const REPLACEMENT_CHARACTER = "�";
const COERCED_LOCALE_NAMES = new Set(["C.UTF-8", "C.utf8", "UTF-8"]);
const C_LOCALE_NAMES = new Set(["C", "POSIX"]);
const ENCODING_ALIASES: Record<string, StdinCodec["encoding"]> = {
  utf8: "utf-8", ascii: "ascii", usascii: "ascii", "646": "ascii", latin1: "latin-1", iso88591: "latin-1", l1: "latin-1", latin: "latin-1",
};

let installedLocales: Set<string> | null = null;

function normalizedEncoding(name: string): string {
  return name.toLowerCase().replaceAll("-", "").replaceAll("_", "").replaceAll(" ", "");
}

function encodingNamed(name: string): StdinCodec["encoding"] {
  const encoding = ENCODING_ALIASES[normalizedEncoding(name)];
  if (encoding === undefined) throw new Error(`unsupported stdin encoding: ${name}`);
  return encoding;
}

function normalizedLocale(name: string): string {
  const [language = "", ...codeset] = name.split(".");
  return [language, normalizedEncoding(codeset.join("."))].join(".").toLowerCase();
}

function listedCharset(name: string): string | null {
  if (installedLocales === null) {
    const listing = spawnSync("locale", ["-a"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    installedLocales = new Set(listing.stdout.split("\n").filter((line) => line !== "").map(normalizedLocale));
  }
  if (!installedLocales.has(normalizedLocale(name))) return null;
  if (!name.includes(".")) throw new Error(`cannot tell the character set of locale ${name}`);
  return name.slice(name.indexOf(".") + 1).split("@")[0] ?? "";
}

function installedCharset(name: string): string | null {
  if (process.platform !== "darwin") return listedCharset(name);
  const table = `${DARWIN_LOCALE_ROOT}/${name}/LC_CTYPE`;
  if (name.includes("/") || !existsSync(table)) return null;
  const directory = basename(dirname(realpathSync(table)));
  return directory.slice(directory.lastIndexOf(".") + 1);
}

function present(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function defaultCodec(env: NodeJS.ProcessEnv): StdinCodec {
  if (env["PYTHONUTF8"] !== "0") return { encoding: "utf-8", errors: "surrogateescape" };
  const requested = present(env, "LC_ALL") ?? present(env, "LC_CTYPE") ?? present(env, "LANG");
  const charset = requested === undefined || C_LOCALE_NAMES.has(requested) ? null : installedCharset(requested);
  if (requested !== undefined && charset !== null) {
    return { encoding: encodingNamed(charset), errors: COERCED_LOCALE_NAMES.has(requested) ? "surrogateescape" : "strict" };
  }
  const coerced = present(env, "LC_ALL") === undefined && env["PYTHONCOERCECLOCALE"] !== "0";
  return { encoding: coerced ? "utf-8" : "ascii", errors: "surrogateescape" };
}

export function stdinCodec(env: NodeJS.ProcessEnv = process.env): StdinCodec {
  const [encodingName = "", errorsName = ""] = (env["PYTHONIOENCODING"] ?? "").split(/:(.*)/s);
  if (encodingName !== "") return { encoding: encodingNamed(encodingName), errors: errorsName !== "" ? errorsName : "strict" };
  const base = defaultCodec(env);
  return { encoding: base.encoding, errors: errorsName !== "" ? errorsName : base.errors };
}

function handled(bytes: Buffer, start: number, end: number, errors: string, failure: () => string): string {
  const range = Array.from(bytes.subarray(start, end));
  switch (errors) {
    case "strict": throw new ValueError(failure());
    case "surrogateescape": return range.map((byte) => String.fromCharCode(SURROGATE_ESCAPE_BASE + byte)).join("");
    case "replace": return REPLACEMENT_CHARACTER;
    case "ignore": return "";
    case "backslashreplace": return range.map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
    default: throw new Error(`unusable stdin error handler: ${errors}`);
  }
}

function decodeAscii(bytes: Buffer, errors: string): string {
  let text = "";
  let from = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if ((bytes[index] ?? 0) < ASCII_LIMIT) continue;
    text += bytes.subarray(from, index).toString("latin1");
    text += handled(bytes, index, index + 1, errors, () =>
      `'ascii' codec can't decode byte 0x${(bytes[index] ?? 0).toString(16).padStart(2, "0")} in position ${index}: ordinal not in range(128)`);
    from = index + 1;
  }
  return text + bytes.subarray(from).toString("latin1");
}

function decodeUtf8(bytes: Buffer, errors: string): string {
  let text = "";
  let from = 0;
  for (;;) {
    const problem: Utf8Problem | null = utf8Problem(bytes, from);
    if (problem === null) return text + bytes.subarray(from).toString("utf8");
    text += bytes.subarray(from, problem.start).toString("utf8");
    text += handled(bytes, problem.start, problem.end, errors, () => decodeFailure(bytes, problem));
    from = problem.end;
  }
}

export function decodeStdin(bytes: Buffer, env: NodeJS.ProcessEnv = process.env): string {
  if (!bytes.some((byte) => byte >= ASCII_LIMIT)) {
    const named = (env["PYTHONIOENCODING"] ?? "").split(":")[0] ?? "";
    if (named !== "") encodingNamed(named);
    return bytes.toString("latin1");
  }
  const { encoding, errors } = stdinCodec(env);
  if (encoding === "latin-1") return bytes.toString("latin1");
  return encoding === "ascii" ? decodeAscii(bytes, errors) : decodeUtf8(bytes, errors);
}
