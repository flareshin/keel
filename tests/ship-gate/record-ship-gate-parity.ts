import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asciiJson, deltaOf, envTemplate, materialize, runInSandbox, SnapshotPacker, tokenized, writeFixtureFile } from "../recorded-cases.ts";
import { KEEL_HOME } from "./helpers.ts";
import { FIXTURE_DIRECTORY, readTree } from "./ship-gate-parity.ts";
import type { RecordedCase, RecordedStore, Suite } from "./ship-gate-parity.ts";

const [casesDirectory = "", rootsDirectory = ""] = process.argv.slice(2);
const RUN_TIMEOUT_MS = 120_000;

interface CaseFile {
  test: string;
  label: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  python: string;
}

function recordingRootOf(suite: string): string {
  return readFileSync(join(rootsDirectory, `root-${suite}`), "utf8").trim();
}

const packer = new SnapshotPacker();
const envs: Array<Record<string, string>> = [];
const lines: string[] = [];
const rootLengths = new Set<number>();
for (const id of readdirSync(casesDirectory).sort()) {
  const suite = id.slice(0, id.lastIndexOf("-"));
  const root = recordingRootOf(suite);
  rootLengths.add(root.length);
  const directory = join(casesDirectory, id);
  const recorded = JSON.parse(readFileSync(join(directory, "case.json"), "utf8")) as CaseFile;
  const snapshot = packer.addTree(join(directory, "root"), root);
  const store = { ...packer.store, rootLength: root.length, envs };
  const execution = { command: [recorded.python, join(KEEL_HOME, recorded.script), ...recorded.args], stdin: recorded.stdin, env: recorded.env, cwd: recorded.cwd, timeoutMs: RUN_TIMEOUT_MS };
  const run = runInSandbox(root, (target) => materialize(store, snapshot, target), execution, readTree);
  const template = envTemplate(recorded.env, process.env, root);
  let env = envs.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(template));
  if (env < 0) env = envs.push(template) - 1;
  const entry: RecordedCase = {
    id, suite: suite as Suite, test: recorded.test, label: recorded.label, script: recorded.script.replace(/\.py$/, ".ts"), args: recorded.args,
    cwd: tokenized(recorded.cwd, root), stdin: tokenized(recorded.stdin, root), env, snapshot, expected: deltaOf(root, run),
  };
  lines.push(asciiJson(entry));
}
if (rootLengths.size !== 1) throw new Error(`recording roots differ in length: ${[...rootLengths].join(", ")}`);
const store: RecordedStore = { ...packer.store, rootLength: [...rootLengths][0] as number, envs };
mkdirSync(FIXTURE_DIRECTORY, { recursive: true });
writeFixtureFile(FIXTURE_DIRECTORY, "cases.jsonl", lines.join("\n") + "\n", true);
writeFixtureFile(FIXTURE_DIRECTORY, "snapshots.json", asciiJson(store) + "\n", true);
console.log(JSON.stringify({ recorded: lines.length }));
