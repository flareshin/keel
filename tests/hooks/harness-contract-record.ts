import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_DIRECTORY, scrubTranscript, versionOf } from "./harness-contract.ts";

function record(argv: string[]): void {
  const [transcript, name] = argv;
  if (transcript === undefined || name === undefined || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error("usage: node tests/hooks/harness-contract-record.ts <agent transcript .jsonl> <fixture-name>");
  }
  const scrubbed = scrubTranscript(readFileSync(transcript, "utf8"));
  const target = join(FIXTURE_DIRECTORY, `${name}.jsonl`);
  writeFileSync(target, scrubbed);
  console.log(`recorded ${scrubbed.split("\n").length - 1} scrubbed lines of harness ${versionOf(scrubbed)} in ${target}`);
}

if (import.meta.main) record(process.argv.slice(2));
