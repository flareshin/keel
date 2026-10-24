const MULTIPLIER = 0x6d2b79f5;
const UNIT_INTERVAL = 4294967296;

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULTIPLIER) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UNIT_INTERVAL;
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
