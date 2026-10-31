import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_DIRECTORY, goldenOutcomes } from "./hook-parity.ts";
import type { RecordedCase } from "./hook-parity.ts";
import { asciiJson } from "./hook-parity-adversarial.ts";

const CASES_FILE = join(FIXTURE_DIRECTORY, "cases.jsonl");
const ADVERSARIAL_FILE = join(FIXTURE_DIRECTORY, "adversarial.json");

function recordGolden(): void {
  const golden = goldenOutcomes();
  const lines = readFileSync(CASES_FILE, "utf8").split("\n").filter((line) => line !== "").map((line) => {
    const recorded = JSON.parse(line) as RecordedCase;
    const expected = golden.recorded.get(recorded.id);
    if (expected === undefined) throw new Error(`no golden outcome for case ${recorded.id}`);
    return asciiJson({ ...recorded, expected });
  });
  writeFileSync(CASES_FILE, lines.join("\n") + "\n");
  writeFileSync(ADVERSARIAL_FILE, asciiJson(golden.adversarial) + "\n");
  console.log(`recorded the golden outcome of ${lines.length} cases and ${Object.keys(golden.adversarial).length} adversarial payloads in ${FIXTURE_DIRECTORY}`);
}

if (import.meta.main) recordGolden();
