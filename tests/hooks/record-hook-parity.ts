import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asciiJson, deltaOf, envTemplate, materialize, runInSandbox, SnapshotPacker, tokenized } from "../recorded-cases.ts";
import { KEEL_HOME } from "./helpers.ts";
import { buildAdversarialSet } from "./hook-parity-adversarial.ts";
import { adversarialInputDigest, copyTree, FIXTURE_DIRECTORY, readTree, RUN_TIMEOUT_MS } from "./hook-parity.ts";
import type { RecordedAdversarial, RecordedCase, RecordedStore } from "./hook-parity.ts";

const [casesDirectory = "", recordingRoot = ""] = process.argv.slice(2);

interface CaseFile {
  test: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  python: string;
}

function recordCases(): { lines: string[]; store: RecordedStore } {
  const packer = new SnapshotPacker();
  const envs: Array<Record<string, string>> = [];
  const lines: string[] = [];
  for (const id of readdirSync(casesDirectory).sort()) {
    const directory = join(casesDirectory, id);
    const recorded = JSON.parse(readFileSync(join(directory, "case.json"), "utf8")) as CaseFile;
    const snapshot = packer.addTree(join(directory, "root"), recordingRoot);
    const store = { ...packer.store, rootLength: recordingRoot.length, envs };
    const command = [recorded.python, join(KEEL_HOME, recorded.script), ...recorded.args];
    const run = runInSandbox(recordingRoot, (root) => materialize(store, snapshot, root), { command, stdin: recorded.stdin, env: recorded.env, cwd: recorded.cwd, timeoutMs: RUN_TIMEOUT_MS }, readTree);
    const template = envTemplate(recorded.env, process.env, recordingRoot);
    let env = envs.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(template));
    if (env < 0) env = envs.push(template) - 1;
    const entry: RecordedCase = {
      id, test: recorded.test, script: recorded.script.replace(/\.py$/, ".ts"), args: recorded.args,
      cwd: tokenized(recorded.cwd, recordingRoot), stdin: tokenized(recorded.stdin, recordingRoot), env, snapshot,
      expected: deltaOf(recordingRoot, run),
    };
    lines.push(asciiJson(entry));
  }
  return { lines, store: { ...packer.store, rootLength: recordingRoot.length, envs } };
}

function recordAdversarial(): Record<string, RecordedAdversarial> {
  const adversarial = buildAdversarialSet();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keel-record-adversarial-")));
  const recorded: Record<string, RecordedAdversarial> = {};
  try {
    const snapshot = join(base, "snapshot");
    copyTree(adversarial.sandbox.root, snapshot);
    for (const testCase of adversarial.cases) {
      if (testCase.divergence !== undefined) continue;
      const root = adversarial.sandbox.root;
      const command = ["python3", join(KEEL_HOME, testCase.script.replace(/\.ts$/, ".py")), ...testCase.args];
      const execution = { command, stdin: testCase.stdin, env: adversarial.sandbox.env, cwd: testCase.cwd, timeoutMs: RUN_TIMEOUT_MS };
      const run = runInSandbox(root, (target: string) => copyTree(snapshot, target), execution, readTree);
      recorded[testCase.name] = { input: adversarialInputDigest(testCase, root), expected: deltaOf(root, run) };
    }
  } finally {
    adversarial.sandbox.close();
    rmSync(base, { recursive: true, force: true });
  }
  return recorded;
}

mkdirSync(FIXTURE_DIRECTORY, { recursive: true });
const { lines, store } = recordCases();
writeFileSync(join(FIXTURE_DIRECTORY, "cases.jsonl"), lines.join("\n") + "\n");
writeFileSync(join(FIXTURE_DIRECTORY, "snapshots.json"), asciiJson(store) + "\n");
writeFileSync(join(FIXTURE_DIRECTORY, "adversarial.json"), asciiJson(recordAdversarial()) + "\n");
console.log(JSON.stringify({ recorded: lines.length }));
