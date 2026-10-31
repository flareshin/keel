import { recordAnswers } from "../../tests/recorded.ts";
import { GOLDEN_DOCUMENT, inWorkers } from "./hook-parity.ts";
import type { GoldenEntry } from "./hook-parity.ts";

export async function goldenOfCorpus(): Promise<GoldenEntry[]> {
  return (await inWorkers<GoldenEntry[]>("record")).flat();
}

async function recordGolden(): Promise<void> {
  const entries = await goldenOfCorpus();
  recordAnswers(GOLDEN_DOCUMENT, entries);
  console.log(`recorded the golden outcome of ${entries.length} cases in ${GOLDEN_DOCUMENT}`);
}

if (import.meta.main) await recordGolden();
