import { recordedAnswers } from "../../tests/recorded.ts";
import { pythonFloatRepr } from "../lib/pyjson.ts";
import { TomlTemporal } from "../lib/toml.ts";
import type { TomlValue } from "../lib/toml.ts";


export interface ReferenceCall {
  fn: string;
  args: unknown[];
}

export interface Outcome {
  ok?: unknown;
  error?: string;
  type?: string;
}

export function pythonReference(cwd: string, calls: ReferenceCall[]): Outcome[] {
  return recordedAnswers<ReferenceCall, Outcome>("codex-pyref", calls, { "{{CWD}}": cwd });
}

export function outcomeOf(body: () => unknown): Outcome {
  try {
    return { ok: body() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message, type: error.name };
  }
}

export function tomlFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return Object.is(value, -0) ? "-0.0" : `${value}.0`;
  return pythonFloatRepr(value);
}

export function canonicalToml(value: TomlValue): unknown {
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "bigint") return { t: "int", v: value.toString() };
  if (typeof value === "number") return { t: "float", v: tomlFloatRepr(value) };
  if (typeof value === "string") return { t: "str", v: value };
  if (value instanceof TomlTemporal) {
    if (value.kind === "date") return { t: "date", v: [value.year, value.month, value.day] };
    if (value.kind === "time") return { t: "time", v: [value.hour, value.minute, value.second, value.microsecond] };
    return {
      t: "datetime",
      v: [value.year, value.month, value.day, value.hour, value.minute, value.second, value.microsecond, value.offsetMinutes],
    };
  }
  if (Array.isArray(value)) return { t: "array", v: value.map(canonicalToml) };
  return { t: "table", v: Array.from(value, ([key, item]) => [key, canonicalToml(item)]) };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function mutate(base: string, alphabet: readonly string[], random: () => number): string {
  const characters = Array.from(base);
  const rounds = 1 + Math.floor(random() * 3);
  for (let round = 0; round < rounds; round += 1) {
    const at = Math.floor(random() * (characters.length + 1));
    const pick = alphabet[Math.floor(random() * alphabet.length)] ?? "";
    const operation = Math.floor(random() * 5);
    if (operation === 0) characters.splice(at, 1);
    else if (operation === 1) characters.splice(at, 0, pick);
    else if (operation === 2) characters.splice(at, 1, pick);
    else if (operation === 3) characters.length = at;
    else characters.splice(at, 0, ...characters.slice(Math.max(0, at - 3), at));
  }
  return characters.join("");
}
