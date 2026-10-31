import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundaries } from "./boundary-table.ts";

export const GOLDEN_FILE = join(import.meta.dirname, "..", "..", "tests", "fixtures", "codex", "boundary-recorded.json");

export function goldenProbes(): Record<string, string> {
  const { boundaries: list, close } = boundaries();
  try {
    return Object.fromEntries(list.flatMap((boundary) => boundary.probes.map((probe): [string, string] => [`${boundary.name}/${probe.label}`, probe.observe()])));
  } finally {
    close();
  }
}

function recordGolden(): void {
  const golden = goldenProbes();
  writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 1) + "\n");
  console.log(`recorded the golden outcome of ${Object.keys(golden).length} probes in ${GOLDEN_FILE}`);
}

if (import.meta.main) recordGolden();
