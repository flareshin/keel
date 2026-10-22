import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { canonicalCodec, decodeWithCodec } from "./pycodecs.ts";

export interface StdinCodec {
  codec: string;
  errors: string;
}

const DARWIN_LOCALE_ROOT = "/usr/share/locale";
const ASCII_LIMIT = 0x80;
const BYTE_ORDER_MARK = "\ufeff";
const COERCED_LOCALE_NAMES = new Set(["C.UTF-8", "C.utf8", "UTF-8"]);
const C_LOCALE_NAMES = new Set(["C", "POSIX"]);

let installedLocales: Set<string> | null = null;

function codecNamed(name: string): string {
  const codec = canonicalCodec(name);
  if (codec === null) throw new Error(`unsupported stdin encoding: ${name}`);
  return codec;
}

function normalizedLocale(name: string): string {
  const [language = "", ...codeset] = name.split(".");
  return [language, codeset.join(".").toLowerCase().replaceAll("-", "").replaceAll("_", "")].join(".").toLowerCase();
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
  if (env["PYTHONUTF8"] !== "0") return { codec: "utf_8", errors: "surrogateescape" };
  const requested = present(env, "LC_ALL") ?? present(env, "LC_CTYPE") ?? present(env, "LANG");
  const charset = requested === undefined || C_LOCALE_NAMES.has(requested) ? null : installedCharset(requested);
  if (requested !== undefined && charset !== null) {
    return { codec: codecNamed(charset), errors: COERCED_LOCALE_NAMES.has(requested) ? "surrogateescape" : "strict" };
  }
  const coerced = present(env, "LC_ALL") === undefined && env["PYTHONCOERCECLOCALE"] !== "0";
  return { codec: coerced ? "utf_8" : "ascii", errors: "surrogateescape" };
}

export function stdinCodec(env: NodeJS.ProcessEnv = process.env): StdinCodec {
  const [encodingName = "", errorsName = ""] = (env["PYTHONIOENCODING"] ?? "").split(/:(.*)/s);
  if (encodingName !== "") return { codec: codecNamed(encodingName), errors: errorsName !== "" ? errorsName : "strict" };
  const base = defaultCodec(env);
  return { codec: base.codec, errors: errorsName !== "" ? errorsName : base.errors };
}

export function decodeStdin(bytes: Buffer, env: NodeJS.ProcessEnv = process.env): string {
  if (!bytes.some((byte) => byte >= ASCII_LIMIT)) return bytes.toString("latin1");
  const { codec, errors } = stdinCodec(env);
  return decodeWithCodec(codec, bytes, errors);
}

export function encodeStdout(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const [encodingName = ""] = (env["PYTHONIOENCODING"] ?? "").split(":");
  return text !== "" && canonicalCodec(encodingName) === "utf_8_sig" ? BYTE_ORDER_MARK + text : text;
}
