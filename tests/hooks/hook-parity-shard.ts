import assert from "node:assert/strict";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { fullCorpusRequested, runParity, SHARD_COUNT, summary } from "./hook-parity.ts";

const PARITY_TIMEOUT_MS = 30 * 60_000;
const SHARD_NUMBER = /^hook-parity-shard-(\d+)\.test\.ts$/;
const MAX_DETAILS_SHOWN = 10;

export function describeShard(testFile: string): void {
  const number = Number(SHARD_NUMBER.exec(basename(testFile))?.[1]);
  if (!Number.isInteger(number) || number < 1 || number > SHARD_COUNT) throw new Error(`${testFile} is not a hook parity shard 1..${SHARD_COUNT}`);
  describe(`hook parity with the golden snapshot of the node hooks, shard ${number} of ${SHARD_COUNT}`, () => {
    it("replays its share of the recorded runs and adversarial payloads through node and compares stdout, stderr, exit code and every file outside .git and remotes against the golden outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
      const report = runParity({ index: number - 1, count: SHARD_COUNT });
      console.log(summary(report));
      for (const detail of report.details.slice(0, MAX_DETAILS_SHOWN)) console.log(detail);
      assert.equal(report.sampled, !fullCorpusRequested());
      assert.ok(report.cases > 0, "the shard replayed no case");
      assert.equal(report.mismatches, 0, report.details.slice(0, MAX_DETAILS_SHOWN).join("\n"));
    });
  });
}
