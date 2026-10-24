import { RecursionError, ValueError } from "./pyruntime.ts";

export const MAX_JSON_DEPTH = 10000;

const NON_FINITE_TOKENS = ["-Infinity", "Infinity", "NaN"];
const VALUE_STARTERS = "[{:,";
const JSON_WHITESPACE = " \t\n\r";

export class JsonSyntaxError extends ValueError {
  override name = "JsonSyntaxError";
}

export class NonFiniteJsonNumber extends Error {
  override name = "NonFiniteJsonNumber";
}

export function parseJson(text: string): unknown {
  refuseDeepNesting(text);
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new JsonSyntaxError(error.message);
    throw error;
  }
}

export function parsePayload(raw: string): Record<string, unknown> {
  const payload = parseJson(raw);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ValueError("hook payload is not a JSON object");
  return payload as Record<string, unknown>;
}

export function parseFiniteJson(text: string): unknown {
  const value = parseJson(text);
  if (!holdsOnlyFiniteNumbers(value)) throw new JsonSyntaxError("a number is past the double range");
  return value;
}

export function parseJsonReadingNonFiniteNumbersAsZero(text: string): unknown {
  return parseJson(withNonFiniteNumbersAsZero(text));
}

export function parseTranscriptLine(text: string): unknown {
  try {
    return parseJson(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError && parsesOnlyWithNonFiniteNumbersAsZero(text)) {
      throw new NonFiniteJsonNumber("a transcript line holds NaN or Infinity, which JSON does not allow");
    }
    throw error;
  }
}

function refuseDeepNesting(text: string): void {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "[" || character === "{") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new RecursionError(`JSON nesting is deeper than ${MAX_JSON_DEPTH} levels`);
    } else if (character === "]" || character === "}") {
      depth -= 1;
    }
  }
}

function holdsOnlyFiniteNumbers(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "number" && !Number.isFinite(next)) return false;
    if (typeof next === "object" && next !== null) pending.push(...Object.values(next));
  }
  return true;
}

function parsesOnlyWithNonFiniteNumbersAsZero(text: string): boolean {
  const replaced = withNonFiniteNumbersAsZero(text);
  if (replaced === text) return false;
  try {
    JSON.parse(replaced);
    return true;
  } catch {
    return false;
  }
}

function withNonFiniteNumbersAsZero(text: string): string {
  let replaced = "";
  let lastSignificant = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inString) {
      if (character === "\\") {
        replaced += text.slice(index, index + 2);
        index += 1;
      } else {
        replaced += character;
        if (character === '"') inString = false;
      }
      continue;
    }
    const token = NON_FINITE_TOKENS.find((candidate) => text.startsWith(candidate, index));
    if (token !== undefined && (lastSignificant === "" || VALUE_STARTERS.includes(lastSignificant))) {
      replaced += "0";
      lastSignificant = "0";
      index += token.length - 1;
      continue;
    }
    replaced += character;
    if (!JSON_WHITESPACE.includes(character)) lastSignificant = character;
    if (character === '"') inString = true;
  }
  return replaced;
}
