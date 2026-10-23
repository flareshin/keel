import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { differencesFromRecorded, envFromTemplate, excerpt, materialize, paddedRoot, readFixtureFile, restored, runInSandbox } from "../recorded-cases.ts";
import type { Observation, ObservedDelta, Run, SnapshotStore } from "../recorded-cases.ts";
import { KEEL_HOME } from "./helpers.ts";

export const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "ship-gate-parity");
export const SUITES = ["python-keel", "ts-keel", "message-contract", "extra"] as const;
const RUN_TIMEOUT_MS = 120_000;
const MAX_MISMATCHES_SHOWN = 60;
const DENY_EXIT_CODE = 2;
const FIRES_LOG_NAME = "keel-fires.jsonl";
const FIRES_TIMESTAMP = /"ts": "[^"]*"/g;
const GIT_STATE = new Set(["HEAD", "config", "packed-refs", "FETCH_HEAD", "refs"]);
const UNREADABLE = "<unreadable>";
const OVER_BOUND_NESTINGS = [10001, 200000];
const OVER_BOUND_KINDS = ["gh-answer", "evidence-file", "stdin-push", "stdin-ls"];
const COMMAND_DIVERGENT_NESTINGS = [9999, 10001];

export const EXPECTED_DIVERGENCES: ReadonlyMap<string, number> = new Map([
  ...OVER_BOUND_NESTINGS.flatMap((depth) => OVER_BOUND_KINDS.map((kind): [string, number] => [`${kind}-nested-${depth}`, DENY_EXIT_CODE])),
  ...COMMAND_DIVERGENT_NESTINGS.map((depth): [string, number] => [`command-list-nested-${depth}`, DENY_EXIT_CODE]),
]);

export type Suite = (typeof SUITES)[number];

export interface RecordedCase {
  id: string;
  suite: Suite;
  test: string;
  label: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: number;
  snapshot: string;
  expected: ObservedDelta;
}

export interface RecordedStore extends SnapshotStore {
  rootLength: number;
  envs: Array<Record<string, string>>;
}

export interface ShipGateParityReport {
  cases: number;
  mismatches: number;
  listedDivergences: number;
  denyToPass: number;
  perSuite: Map<string, number>;
  details: string[];
}

export function runShipGateParity(suites: readonly Suite[] = selectedSuites()): ShipGateParityReport {
  const store = JSON.parse(readFixtureFile(FIXTURE_DIRECTORY, "snapshots.json")) as RecordedStore;
  const root = paddedRoot(realpathSync(tmpdir()), store.rootLength);
  const report: ShipGateParityReport = { cases: 0, mismatches: 0, listedDivergences: 0, denyToPass: 0, perSuite: new Map(), details: [] };
  const seenLabels = new Set<string>();
  try {
    for (const testCase of loadCases(suites)) {
      const run = replay(testCase, store, root);
      const verdict = judgeCase(testCase.label, testCase.expected, run, root);
      report.cases += 1;
      report.perSuite.set(testCase.suite, (report.perSuite.get(testCase.suite) ?? 0) + 1);
      if (testCase.label) seenLabels.add(testCase.label);
      if (isDenyToPass(testCase.expected, run.observation)) report.denyToPass += 1;
      if (verdict.listed) report.listedDivergences += 1;
      if (verdict.problems.length > 0) {
        report.mismatches += 1;
        report.details.push(`case ${testCase.id} (${testCase.test}) stdin ${excerpt(restored(testCase.stdin, root))}:\n  ${verdict.problems.join("\n  ")}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (suites.includes("extra") && !process.env["SHIP_GATE_PARITY_CASES"]) {
    for (const label of EXPECTED_DIVERGENCES.keys()) {
      if (seenLabels.has(label)) continue;
      report.mismatches += 1;
      report.details.push(`expected divergence ${label} was not recorded`);
    }
  }
  return report;
}

function selectedSuites(): readonly Suite[] {
  const chosen = process.env["SHIP_GATE_PARITY_SUITES"];
  if (!chosen) return SUITES;
  return chosen.split(",").map((name) => {
    if (!(SUITES as readonly string[]).includes(name)) throw new Error(`unknown parity suite ${name}`);
    return name as Suite;
  });
}

function loadCases(suites: readonly Suite[]): RecordedCase[] {
  const only = process.env["SHIP_GATE_PARITY_CASES"];
  const lines = readFixtureFile(FIXTURE_DIRECTORY, "cases.jsonl").split("\n").filter((line) => line !== "");
  return lines.map((line) => JSON.parse(line) as RecordedCase).filter((testCase) => suites.includes(testCase.suite) && (!only || new RegExp(only).test(testCase.id)));
}

function replay(testCase: RecordedCase, store: RecordedStore, root: string): Run {
  const execution = {
    command: [process.execPath, join(KEEL_HOME, testCase.script), ...testCase.args], stdin: restored(testCase.stdin, root),
    env: envFromTemplate(store.envs[testCase.env] as Record<string, string>, root), cwd: restored(testCase.cwd, root), timeoutMs: RUN_TIMEOUT_MS,
  };
  return runInSandbox(root, (target) => materialize(store, testCase.snapshot, target), execution, readTree);
}

export function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string, insideGit: boolean): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      if (key === "remotes" || (insideGit && directory.endsWith(".git") && !GIT_STATE.has(name))) continue;
      const status = lstatSync(path);
      if (status.isSymbolicLink()) files.set(key, `-> ${readlinkSync(path)}`);
      else if (status.isDirectory()) {
        files.set(key + "/", "");
        visit(path, insideGit || name === ".git");
      } else files.set(key, normalized(key, readOrMark(path)));
    }
  };
  visit(root, false);
  return files;
}

function readOrMark(path: string): string {
  try {
    return readFileSync(path).toString("latin1");
  } catch {
    return UNREADABLE;
  }
}

function normalized(key: string, content: string): string {
  return key.endsWith(FIRES_LOG_NAME) ? content.replace(FIRES_TIMESTAMP, '"ts": "<ts>"') : content;
}

export interface Verdict {
  listed: boolean;
  problems: string[];
}

export function judgeCase(label: string, expected: ObservedDelta, run: Run, root: string): Verdict {
  const differences = differencesFromRecorded(expected, run, root);
  const required = EXPECTED_DIVERGENCES.get(label);
  const code = run.observation.code;
  if (required === undefined) return { listed: false, problems: differences };
  if (code === required) return { listed: true, problems: [] };
  return { listed: false, problems: [`listed divergence ${label} requires node exit ${required}, got ${code}`, ...differences] };
}

export function isDenyToPass(expected: ObservedDelta, actual: Observation): boolean {
  return expected.code === DENY_EXIT_CODE && actual.code !== DENY_EXIT_CODE;
}

export function summary(report: ShipGateParityReport): string[] {
  return [`parity: ${report.cases} cases, ${report.mismatches} mismatches, ${report.listedDivergences} listed divergences`, `deny-to-pass: ${report.denyToPass}`];
}

if (import.meta.main) {
  const report = runShipGateParity();
  for (const detail of report.details.slice(0, MAX_MISMATCHES_SHOWN)) console.log(detail);
  console.log(JSON.stringify({ perSuite: Object.fromEntries(report.perSuite) }));
  for (const line of summary(report)) console.log(line);
  process.exitCode = report.mismatches === 0 && report.denyToPass === 0 ? 0 : 1;
}
