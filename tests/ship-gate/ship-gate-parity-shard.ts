import assert from "node:assert/strict";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { runShipGateParity, SHARD_COUNT, summary } from "./ship-gate-parity.ts";

const PARITY_TIMEOUT_MS = 120 * 60_000;
const SHARD_NUMBER = /^ship-gate-parity-shard-(\d+)\.test\.ts$/;

export function describeShard(testFile: string): void {
  const number = Number(SHARD_NUMBER.exec(basename(testFile))?.[1]);
  if (!Number.isInteger(number) || number < 1 || number > SHARD_COUNT) throw new Error(`${testFile} is not a ship-gate parity shard 1..${SHARD_COUNT}`);
  describe(`ship-gate parity with the recorded golden, shard ${number} of ${SHARD_COUNT}`, () => {
    it("replays its share of the recorded ship-gate payloads through node and compares each result with the recorded golden outcome", { timeout: PARITY_TIMEOUT_MS }, () => {
      const report = runShipGateParity({ index: number - 1, count: SHARD_COUNT });
      for (const line of summary(report)) console.log(line);
      for (const detail of report.details.slice(0, 10)) console.log(detail);
      assert.ok(report.cases > 0, "the shard replayed no case");
      assert.equal(report.mismatches, 0, report.details.slice(0, 10).join("\n"));
    });
  });
}
