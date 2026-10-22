/**
 * Known secret values the agent must never write out (F-secrets; overlay `git-guard/known-values.tsv`).
 *
 * Rows are `source<TAB>pattern`: `file` globs config files whose secret-named keys supply values; `env`
 * names a variable whose value counts. Values stay in memory: a hit names file, line and key, never the value.
 */
import { globSync, readFileSync } from "node:fs";
import { basename, codePointLength, expandUser, PY_SPACE, PY_WORD, sortedByCodePoint, splitlines } from "./pycompat.ts";
import { OverlayDataError, readTsv } from "./overlay.ts";

export const HEADER = ["source", "pattern"] as const;
export const SOURCE_FILE = "file";
export const SOURCE_ENV = "env";
export const MIN_LENGTH = 6;
const SPACE = `[${PY_SPACE}]`;
const SECRET_KEY_RE = /pass|pwd|secret|token|key|credential|auth/iu;
const KEY_VALUE_RE = new RegExp(
  `^${SPACE}*(?:export${SPACE}+)?["']?([A-Za-z_][${PY_WORD}.-]*)["']?${SPACE}*[:=]${SPACE}*["']?([^\\n]+?)["']?${SPACE}*,?${SPACE}*$`, "u");
const TRAILING_COMMENT_RE = new RegExp(`${SPACE}+#[^\\n]*$`, "u");
const HUNK_RE = new RegExp(`^@@ -[^${PY_SPACE}]+ \\+([0-9]+)`, "u");

/** (path, line number, text) */
export type Line = readonly [path: string, number: number, text: string];

export interface KnownValue {
  value: string;
  key: string;
  /** config file basename, or "env" */
  origin: string;
}

export class Hit {
  readonly path: string;
  readonly line: number;
  readonly known: KnownValue;

  constructor(path: string, line: number, known: KnownValue) {
    this.path = path;
    this.line = line;
    this.known = known;
  }

  describe(): string {
    return `${this.path}:${this.line} holds the value of ${this.known.key} (${this.known.origin})`;
  }
}

export function load(path: string): KnownValue[] {
  const values: KnownValue[] = [];
  for (const row of readTsv(path, HEADER)) {
    const source = row["source"];
    const pattern = row["pattern"] ?? "";
    if (source === SOURCE_ENV) {
      values.push({ value: process.env[pattern] ?? "", key: pattern, origin: SOURCE_ENV });
    } else if (source === SOURCE_FILE) {
      for (const file of sortedByCodePoint(globSync(expandUser(pattern)))) values.push(...fileValues(file));
    } else {
      throw new OverlayDataError(`${path}: source must be ${SOURCE_FILE} or ${SOURCE_ENV}, not '${source}'`);
    }
  }
  return values.filter((known) => codePointLength(known.value) >= MIN_LENGTH);
}

export function find(lines: Iterable<Line>, values: readonly KnownValue[]): Hit[] {
  const hits: Hit[] = [];
  for (const [path, number, text] of lines) {
    for (const known of values) if (text.includes(known.value)) hits.push(new Hit(path, number, known));
  }
  return hits;
}

export function* numberedLines(path: string, text: string): Generator<Line> {
  const lines = splitlines(text);
  for (const [index, line] of lines.entries()) yield [path, index + 1, line];
}

/** Every added line of a unified diff with its path and new line number. */
export function* addedLines(diff: string): Generator<Line> {
  let path: string | null = null;
  let number = 0;
  let previous = "";
  for (const raw of splitlines(diff)) {
    const hunk = HUNK_RE.exec(raw);
    if (raw.startsWith("+++ ") && previous.startsWith("--- ")) {
      const named = raw.slice(4).split("\t")[0] ?? "";
      path = named.startsWith("b/") ? named.slice(2) : named;
    } else if (hunk) {
      number = Number(hunk[1]);
    } else if (raw.startsWith("+") && path) {
      yield [path, number, raw.slice(1)];
      number += 1;
    } else if (raw.startsWith(" ")) {
      number += 1;
    }
    previous = raw;
  }
}

function fileValues(file: string): KnownValue[] {
  let lines: string[];
  try {
    lines = splitlines(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const values: KnownValue[] = [];
  for (const line of lines) {
    const match = KEY_VALUE_RE.exec(line);
    if (match && SECRET_KEY_RE.test(match[1] ?? "")) {
      const value = (match[2] ?? "").replace(TRAILING_COMMENT_RE, "").replace(/^["']+|["']+$/g, "");
      values.push({ value, key: match[1] ?? "", origin: basename(file) });
    }
  }
  return values;
}
