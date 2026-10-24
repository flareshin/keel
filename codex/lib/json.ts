import { isJsonObject, parseJson, parseJsonKeepingIntegers } from "../../measure/lib/measurekit/json.ts";
import type { JsonObject, JsonValue } from "../../measure/lib/measurekit/json.ts";
import { Refusal } from "./refusal.ts";

export { isJsonObject };
export type { JsonObject, JsonValue };

const INTEGER_DIGIT_LIMIT = 4300;
const LONG_DIGIT_RUN = new RegExp(`[0-9]{${INTEGER_DIGIT_LIMIT + 1}}`);
const INTEGER_TOKEN = /^-?[0-9]+$/;
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
const ESCAPE_WIDTH = 4;

type SourceReviver = (key: string, value: unknown, context: { source?: string }) => unknown;

export function parseHookJson(text: string): JsonValue {
  return parseDocument(text, parseJson);
}

export function parseStateJson(text: string): JsonValue {
  return parseDocument(text, parseJsonKeepingIntegers);
}

export function asciiJson(value: JsonValue): string {
  return JSON.stringify(value).replace(NON_PRINTABLE_ASCII, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(ESCAPE_WIDTH, "0"));
}

export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isJsonObject(value)) return Object.keys(value).length > 0;
  return true;
}

function parseDocument(text: string, parse: (text: string) => JsonValue): JsonValue {
  try {
    const value = parse(text);
    if (LONG_DIGIT_RUN.test(text)) refuseOversizedIntegers(text);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Refusal(`invalid JSON: ${error.message}`);
    throw error;
  }
}

function refuseOversizedIntegers(text: string): void {
  try {
    const parse = JSON.parse as (text: string, reviver: SourceReviver) => unknown;
    parse(text, (_key, value, context) => {
      if (typeof value === "number" && isOversizedInteger(context.source)) throw new Refusal(`JSON integer exceeds ${INTEGER_DIGIT_LIMIT} digits`);
      return value;
    });
  } catch (error) {
    if (error instanceof RangeError) throw new Refusal(`JSON nests too deeply to check its integers for the ${INTEGER_DIGIT_LIMIT} digit limit`);
    throw error;
  }
}

function isOversizedInteger(source: string | undefined): boolean {
  return source !== undefined && INTEGER_TOKEN.test(source) && source.replace("-", "").length > INTEGER_DIGIT_LIMIT;
}
