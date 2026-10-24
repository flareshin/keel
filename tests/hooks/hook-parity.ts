import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { differencesFromRecorded, digestOf, envFromTemplate, excerpt, materialize, paddedRoot, restored, runInSandbox, tokenized } from "../recorded-cases.ts";
import type { Observation, ObservedDelta, Run, SnapshotStore } from "../recorded-cases.ts";
import { KEEL_HOME } from "./helpers.ts";
import { buildAdversarialSet } from "./hook-parity-adversarial.ts";
import type { AdversarialCase, AdversarialSet } from "./hook-parity-adversarial.ts";
import type { TsOutcome } from "./hook-parity-json-limits.ts";

export const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "hook-parity");
export const RUN_TIMEOUT_MS = 60_000;
const MAX_MISMATCHES_SHOWN = 12;
const FIRES_TIMESTAMP = /^(\{"ts": ")[^"]*(")/;
const HANDOFF_TIMESTAMP = /^(> Generated )\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /m;
const UNREADABLE = "<unreadable>";
const GIT_DIRECTORY = ".git";
const REMOTES_TREE = "remotes";
const FIRES_PATH = join("data", "logs", "keel-fires.jsonl");
const PYTHON_DECODE_ERROR_NAME = "(JSONDecodeError)";
const DECODE_ERROR_NAME = "(JsonSyntaxError)";
const PYTHON_DECODE_DETAIL = /\b(JSONDecodeError: |payload is not JSON: )(?:[^"\\]|\\.)*?: line \d+ column \d+ \(char \d+\)/g;
const NODE_DECODE_DETAIL = /\b(JsonSyntaxError: |payload is not JSON: )(?!hook payload is not a JSON object)(?:[^"\\]|\\.)*/g;
const DECODE_MESSAGE = "<JSON syntax error message>";

interface Case {
  id: string;
  test: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  root: string;
  prepare: (root: string) => void;
  divergence?: TsOutcome;
  expected?: ObservedDelta;
}

export interface RecordedCase {
  id: string;
  test: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: number;
  snapshot: string;
  expected: ObservedDelta;
}

export interface RecordedAdversarial {
  input: string;
  expected: ObservedDelta;
}

export interface RecordedStore extends SnapshotStore {
  rootLength: number;
  envs: Array<Record<string, string>>;
}

export interface ParityReport {
  cases: number;
  adversarial: number;
  divergences: number;
  mismatches: number;
  perHook: Map<string, number>;
  details: string[];
}

export function runParity(): ParityReport {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keel-parity-")));
  const adversarial = buildAdversarialSet();
  try {
    const report: ParityReport = { cases: 0, adversarial: 0, divergences: 0, mismatches: 0, perHook: new Map(), details: [] };
    const store = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "snapshots.json"), "utf8")) as RecordedStore;
    const sandboxRoot = paddedRoot(realpathSync(tmpdir()), store.rootLength);
    for (const testCase of recordedCases(store, sandboxRoot)) replay(testCase, report);
    for (const testCase of adversarialCases(adversarial, join(base, "adversarial"))) {
      replay(testCase, report);
      report.adversarial += 1;
    }
    return report;
  } finally {
    adversarial.sandbox.close();
    rmSync(base, { recursive: true, force: true });
  }
}

function replay(testCase: Case, report: ParityReport): void {
  const run = observe(testCase);
  const differences = testCase.divergence ? unmetOutcome(testCase.divergence, run.observation) : compareWithRecorded(testCase, run);
  if (testCase.divergence) report.divergences += 1;
  report.cases += 1;
  report.perHook.set(testCase.script, (report.perHook.get(testCase.script) ?? 0) + 1);
  if (differences.length > 0) {
    report.mismatches += 1;
    report.details.push(`case ${testCase.id} (${testCase.test}) ${testCase.script}:\n  ${differences.join("\n  ")}`);
  }
}

function recordedCases(store: RecordedStore, sandboxRoot: string): Case[] {
  const lines = readFileSync(join(FIXTURE_DIRECTORY, "cases.jsonl"), "utf8").split("\n").filter((line) => line !== "");
  return lines.map((line) => {
    const recorded = JSON.parse(line) as RecordedCase;
    return {
      id: recorded.id, test: recorded.test, script: recorded.script, args: recorded.args, cwd: restored(recorded.cwd, sandboxRoot),
      stdin: restored(recorded.stdin, sandboxRoot), env: envFromTemplate(store.envs[recorded.env] as Record<string, string>, sandboxRoot),
      root: sandboxRoot, prepare: (root) => materialize(store, recorded.snapshot, root), expected: recorded.expected,
    };
  });
}

export function adversarialInputDigest(adversarialCase: Pick<AdversarialCase, "script" | "stdin" | "args" | "cwd">, root: string): string {
  return digestOf(tokenized(JSON.stringify([adversarialCase.script, adversarialCase.stdin, adversarialCase.args, adversarialCase.cwd]), root));
}

function adversarialCases(adversarial: AdversarialSet, snapshot: string): Case[] {
  const sandbox = adversarial.sandbox;
  const recorded = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "adversarial.json"), "utf8")) as Record<string, RecordedAdversarial>;
  copyTree(sandbox.root, snapshot);
  return adversarial.cases.map((adversarialCase, index) => {
    const entry = recorded[adversarialCase.name];
    const drifted = entry !== undefined && entry.input !== adversarialInputDigest(adversarialCase, sandbox.root);
    return {
      id: `adversarial-${String(index + 1).padStart(4, "0")}`, test: adversarialCase.name, script: adversarialCase.script,
      args: adversarialCase.args, cwd: adversarialCase.cwd, stdin: adversarialCase.stdin, env: sandbox.env, root: sandbox.root,
      prepare: (root) => copyTree(snapshot, root), divergence: adversarial.divergences.get(adversarialCase.name),
      expected: drifted ? undefined : entry?.expected,
    };
  });
}

function observe(testCase: Case): Run {
  const command = [process.execPath, join(KEEL_HOME, testCase.script), ...testCase.args];
  return runInSandbox(testCase.root, testCase.prepare, { command, stdin: testCase.stdin, env: testCase.env, cwd: testCase.cwd, timeoutMs: RUN_TIMEOUT_MS }, readTree);
}

export function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    const status = lstatSync(from);
    if (status.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (status.isDirectory()) {
      copyTree(from, to);
      chmodSync(to, status.mode & 0o7777);
    } else {
      copyEvenIfUnreadable(from, to, status.mode & 0o7777);
    }
  }
}

function copyEvenIfUnreadable(from: string, to: string, mode: number): void {
  try {
    copyFileSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    writeFileSync(to, "");
  }
  chmodSync(to, mode);
}

export function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      if (isUncompared(name, key)) continue;
      const status = lstatSync(path);
      if (status.isSymbolicLink()) files.set(key, `-> ${readlinkSync(path)}`);
      else if (status.isDirectory()) {
        files.set(key + "/", "");
        visit(path);
      } else files.set(key, normalized(key, readOrMark(path)));
    }
  };
  visit(root);
  return files;
}

function isUncompared(name: string, key: string): boolean {
  return name === GIT_DIRECTORY || key === REMOTES_TREE;
}

function readOrMark(path: string): string {
  try {
    return readFileSync(path).toString("latin1");
  } catch {
    return UNREADABLE;
  }
}

function normalized(key: string, content: string): string {
  if (key === FIRES_PATH) {
    return content.split("\n").map((line) => line.replace(FIRES_TIMESTAMP, "$1<ts>$2")).join("\n");
  }
  if (key.startsWith(join("data", "handoff") + "/")) return content.replace(HANDOFF_TIMESTAMP, "$1<ts> ");
  return content;
}

function unmetOutcome(outcome: TsOutcome, actual: Observation): string[] {
  const unmet: string[] = [];
  if (actual.code !== outcome.code) unmet.push(`listed divergence: code node ${actual.code}, required ${outcome.code}`);
  if (outcome.stdoutIncludes !== undefined && !actual.stdout.includes(outcome.stdoutIncludes)) {
    unmet.push(`listed divergence: stdout ${excerpt(actual.stdout)} lacks ${excerpt(outcome.stdoutIncludes)}`);
  }
  if (outcome.stdoutEmpty && actual.stdout !== "") unmet.push(`listed divergence: stdout ${excerpt(actual.stdout)} is not empty`);
  if (outcome.stderrIncludes !== undefined && !actual.stderr.includes(outcome.stderrIncludes)) {
    unmet.push(`listed divergence: stderr ${excerpt(actual.stderr)} lacks ${excerpt(outcome.stderrIncludes)}`);
  }
  const fires = actual.files.get(FIRES_PATH) ?? "";
  if (outcome.firesInclude !== undefined && !fires.includes(outcome.firesInclude)) {
    unmet.push(`listed divergence: fires ${excerpt(fires)} lack ${excerpt(outcome.firesInclude)}`);
  }
  return unmet;
}

function compareWithRecorded(testCase: Case, run: Run): string[] {
  if (testCase.expected === undefined) return ["no recorded Python outcome for this case; the corpus changed or the case was never recorded"];
  return differencesFromRecorded(withDecodeWordingAsNode(testCase.expected), withDecodeMessageMasked(run), testCase.root);
}

function withDecodeWordingAsNode(expected: ObservedDelta): ObservedDelta {
  const fires = expected.set[FIRES_PATH];
  const set = fires === undefined ? expected.set : { ...expected.set, [FIRES_PATH]: maskedDecodeDetail(fires) };
  return { ...expected, stderr: expected.stderr.replaceAll(PYTHON_DECODE_ERROR_NAME, DECODE_ERROR_NAME), set };
}

function maskedDecodeDetail(fires: string): string {
  return fires
    .replace(PYTHON_DECODE_DETAIL, (_match, prefix: string) => `${prefix === "JSONDecodeError: " ? "JsonSyntaxError: " : prefix}${DECODE_MESSAGE}`)
    .replace(NODE_DECODE_DETAIL, (_match, prefix: string) => `${prefix}${DECODE_MESSAGE}`);
}

function withDecodeMessageMasked(run: Run): Run {
  const fires = run.observation.files.get(FIRES_PATH);
  if (fires === undefined) return run;
  const files = new Map(run.observation.files).set(FIRES_PATH, maskedDecodeDetail(fires));
  return { ...run, observation: { ...run.observation, files } };
}

export function summary(report: ParityReport): string {
  return `parity: ${report.cases - report.adversarial} recorded + ${report.adversarial} adversarial cases (${report.divergences} listed divergences), ${report.mismatches} mismatches`;
}

if (import.meta.main) {
  const report = runParity();
  for (const detail of report.details.slice(0, MAX_MISMATCHES_SHOWN)) console.log(detail);
  console.log(JSON.stringify({ perHook: Object.fromEntries(report.perHook) }));
  console.log(summary(report));
  process.exitCode = report.mismatches === 0 ? 0 : 1;
}
