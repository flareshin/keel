import { compareCodePoints } from "./pycompat.ts";

const SYNTAX_CHARACTERS = new Set("^$\\.*+?()[]{}|/");
const MATCH_ANY = ".";
const MATCH_NOTHING = "(?!)";

const compiled = new Map<string, RegExp>();

export function fnmatchCase(name: string, pattern: string): boolean {
  let expression = compiled.get(pattern);
  if (expression === undefined) {
    expression = new RegExp(`^(?:${translate(pattern)})$`, "su");
    compiled.set(pattern, expression);
  }
  return expression.test(name);
}

function translate(pattern: string): string {
  const characters = Array.from(pattern);
  const parts: string[] = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index] ?? "";
    index += 1;
    if (character === "*") {
      parts.push(".*");
      while (characters[index] === "*") index += 1;
    } else if (character === "?") {
      parts.push(MATCH_ANY);
    } else if (character === "[") {
      const close = closingBracket(characters, index);
      if (close >= characters.length) {
        parts.push("\\[");
      } else {
        parts.push(translateSet(characters.slice(index, close)));
        index = close + 1;
      }
    } else {
      parts.push(literal(character));
    }
  }
  return parts.join("");
}

function closingBracket(characters: readonly string[], start: number): number {
  let end = start;
  if (characters[end] === "!") end += 1;
  if (characters[end] === "]") end += 1;
  while (end < characters.length && characters[end] !== "]") end += 1;
  return end;
}

function translateSet(set: readonly string[]): string {
  const chunks = set.includes("-") ? rangeChunks(set) : [set.join("")];
  const joined = chunks.join("-");
  if (joined === "") return MATCH_NOTHING;
  if (joined === "!") return MATCH_ANY;
  const negated = joined.startsWith("!");
  const body = chunks.map((chunk, position) => escapeChunk(negated && position === 0 ? chunk.slice(1) : chunk)).join("-");
  return `[${negated ? "^" : ""}${body}]`;
}

function rangeChunks(set: readonly string[]): string[] {
  const chunks: string[] = [];
  let chunkStart = 0;
  let search = set[0] === "!" ? 2 : 1;
  for (let hyphen = set.indexOf("-", search); hyphen >= 0; hyphen = set.indexOf("-", search)) {
    chunks.push(set.slice(chunkStart, hyphen).join(""));
    chunkStart = hyphen + 1;
    search = hyphen + 3;
  }
  const last = set.slice(chunkStart).join("");
  if (last !== "") chunks.push(last);
  else chunks[chunks.length - 1] += "-";
  for (let position = chunks.length - 1; position > 0; position -= 1) {
    const previous = Array.from(chunks[position - 1] ?? "");
    const next = Array.from(chunks[position] ?? "");
    if (compareCodePoints(previous[previous.length - 1] ?? "", next[0] ?? "") > 0) {
      chunks[position - 1] = previous.slice(0, -1).join("") + next.slice(1).join("");
      chunks.splice(position, 1);
    }
  }
  return chunks;
}

function escapeChunk(chunk: string): string {
  return Array.from(chunk, (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`).join("");
}

function literal(character: string): string {
  return SYNTAX_CHARACTERS.has(character) ? `\\${character}` : character;
}
