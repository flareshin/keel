export function trimCharacters(text: string, characters: string): string {
  const letters = Array.from(text);
  let start = 0;
  let end = letters.length;
  while (start < end && characters.includes(letters[start] ?? "")) start += 1;
  while (end > start && characters.includes(letters[end - 1] ?? "")) end -= 1;
  return letters.slice(start, end).join("");
}
