import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ObservedDelta } from "../recorded-cases.ts";
import { FIXTURE_DIRECTORY, goldenDeltas, recordedCorpus, SHARD_COUNT, shardCases } from "./ship-gate-parity.ts";

const CASES_FILE = join(FIXTURE_DIRECTORY, "cases.jsonl.gz");
const SHARD_FLAG = "--shard";

function recordShard(index: number, scratch: string): Promise<Array<[string, ObservedDelta]>> {
  const output = join(scratch, `shard-${index}.json`);
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [import.meta.filename, SHARD_FLAG, String(index), output], { stdio: "inherit" }).on("exit", (code) => {
      if (code === 0) resolve(JSON.parse(readFileSync(output, "utf8")) as Array<[string, ObservedDelta]>);
      else reject(new Error(`golden recording of shard ${index + 1} exited ${code}`));
    });
  });
}

async function recordGolden(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "ship-gate-golden-"));
  try {
    const shards = await Promise.all(Array.from({ length: SHARD_COUNT }, (_unused, index) => recordShard(index, scratch)));
    const golden = new Map(shards.flat());
    const lines = recordedCorpus().map((testCase) => JSON.stringify({ ...testCase, expected: golden.get(testCase.id) }));
    writeFileSync(CASES_FILE, gzipSync(lines.join("\n") + "\n"));
    console.log(`recorded the golden outcome of ${lines.length} cases in ${CASES_FILE}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function recordShardToFile(index: number, output: string): void {
  const deltas = goldenDeltas(shardCases(recordedCorpus(), { index, count: SHARD_COUNT }));
  writeFileSync(output, JSON.stringify([...deltas]));
}

if (import.meta.main) {
  const [flag, index, output] = process.argv.slice(2);
  if (flag === SHARD_FLAG) recordShardToFile(Number(index), output as string);
  else await recordGolden();
}
