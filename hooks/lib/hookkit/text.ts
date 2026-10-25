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
