const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const SHORT_ESCAPES: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const HEX_WIDTH_BYTE = 2;
const HEX_WIDTH_BMP = 4;
const HEX_WIDTH_ASTRAL = 8;
const MAX_BYTE = 0xff;
const MAX_BMP = 0xffff;

export function pythonRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let result = quote;
  for (const character of text) {
    if (character === quote) result += "\\" + quote;
    else result += SHORT_ESCAPES[character] ?? (character !== " " && NOT_PRINTABLE.test(character) ? hexEscape(character) : character);
  }
  return result + quote;
}

function hexEscape(character: string): string {
  const point = character.codePointAt(0) ?? 0;
  if (point <= MAX_BYTE) return "\\x" + point.toString(16).padStart(HEX_WIDTH_BYTE, "0");
  if (point <= MAX_BMP) return "\\u" + point.toString(16).padStart(HEX_WIDTH_BMP, "0");
  return "\\U" + point.toString(16).padStart(HEX_WIDTH_ASTRAL, "0");
}
