export const SPACE_CHARS = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
export const WORD_CHARS = String.raw`\p{L}\p{N}_`;
export const SPACE_CLASS = `[${SPACE_CHARS}]`;
const WORD_CLASS = `[${WORD_CHARS}]`;
export const WORD_BOUNDARY = `(?:(?<=${WORD_CLASS})(?!${WORD_CLASS})|(?<!${WORD_CLASS})(?=${WORD_CLASS}))`;

const DOTTED_OR_DOTLESS_I = /[İı]/g;

export function foldDottedAndDotlessI(text: string): string {
  return text.replace(DOTTED_OR_DOTLESS_I, "i");
}

export function testCaseFolded(pattern: RegExp, text: string): boolean {
  return pattern.test(foldDottedAndDotlessI(text));
}

export function trimCharacters(text: string, characters: string): string {
  const letters = Array.from(text);
  let start = 0;
  let end = letters.length;
  while (start < end && characters.includes(letters[start] ?? "")) start += 1;
  while (end > start && characters.includes(letters[end - 1] ?? "")) end -= 1;
  return letters.slice(start, end).join("");
}

const LEADING_SPACE = new RegExp(`^[${SPACE_CHARS}]+`);
const TRAILING_SPACE = new RegExp(`[${SPACE_CHARS}]+$`);
const SPLITLINES_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const NON_DECIMAL_DIGITS = String.raw`\u00b2\u00b3\u00b9\u1369-\u1371\u19da\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468` +
  String.raw`\u2474-\u247c\u2488-\u2490\u24ea\u24f5-\u24fd\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792` +
  String.raw`\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}`;
const DIGITS = new RegExp(`^[\\p{Nd}${NON_DECIMAL_DIGITS}]+$`, "u");

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

export function truncate(text: string, count: number): string {
  if (count >= 0 && text.length <= count) return text;
  const characters = Array.from(text);
  const end = count < 0 ? Math.max(characters.length + count, 0) : count;
  return characters.slice(0, end).join("");
}

export function splitlines(text: string): string[] {
  const lines = text.split(SPLITLINES_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function trimSpace(text: string): string {
  return text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

export function rstripChar(text: string, character: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === character) end -= 1;
  return text.slice(0, end);
}

export function lstripChar(text: string, character: string): string {
  let start = 0;
  while (start < text.length && text[start] === character) start += 1;
  return text.slice(start);
}

export function partition(text: string, separator: string): [string, string, string] {
  const index = text.indexOf(separator);
  if (index < 0) return [text, "", ""];
  return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

export function isDigits(text: string): boolean {
  return DIGITS.test(text);
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
