import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deltaOf, differencesFromRecorded, envFromTemplate, excerpt, materialize, paddedRoot, readFixtureFile, restored, runInSandbox } from "../recorded-cases.ts";
import type { ObservedDelta, Run, SnapshotStore } from "../recorded-cases.ts";
import { normalizeRepoKey } from "../../lib/evidence/registry.ts";
import { isJsonObject, stringifySorted } from "../../measure/lib/measurekit/json.ts";
import { KEEL_HOME } from "./helpers.ts";
import { FIRES_LOG_NAME } from "../recorded-sample.ts";
import { sampleCorpus } from "./ship-gate-parity-sample.ts";

export const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "ship-gate-parity");
export const SUITES = ["python-keel", "ts-keel", "message-contract", "extra"] as const;
const RUN_TIMEOUT_MS = 120_000;
const MAX_MISMATCHES_SHOWN = 60;
const TIMESTAMP_PLACEHOLDER = "<ts>";
const DECODE_DETAIL = /\bJsonSyntaxError: [^\n]*/g;
const DECODE_DETAIL_MASKED = "JsonSyntaxError: <JSON syntax error message>";
const EVIDENCE_DECODE_DETAIL = /(unreadable evidence \S+?\.json): [^\n]*/g;
const EVIDENCE_DECODE_DETAIL_MASKED = "$1: <JSON syntax error message>";
const CC_VERSION_FILE = ".cc-version";
const CC_VERSION_FIELD = /cc_version=[^"\\]*/g;
const CC_VERSION_PLACEHOLDER = "<version>";
const CHECKOUT_REPO_TOKEN = "{{KEEL_REPO}}";
const RECORDED_CHECKOUT_REPO_KEY = "flareshin/keel";
const CHECKOUT_REPO_KEY = checkoutRepoKey();
const GIT_STATE = new Set(["HEAD", "config", "packed-refs", "FETCH_HEAD", "refs"]);
const UNREADABLE = "<unreadable>";
const GOLDEN_LABEL = "golden";

export type Suite = (typeof SUITES)[number];

export interface Shard {
  index: number;
  count: number;
}

export const SHARD_COUNT = 8;
const WHOLE_CORPUS: Shard = { index: 0, count: 1 };

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
  recorded: number;
  sampled: boolean;
  mismatches: number;
  perSuite: Map<string, number>;
  details: string[];
}

export function runShipGateParity(shard: Shard = WHOLE_CORPUS, suites: readonly Suite[] = selectedSuites(), full: boolean = fullCorpusRequested()): ShipGateParityReport {
  const only = process.env["SHIP_GATE_PARITY_CASES"];
  const recordedMatches = selectCases(loadRecordedCases(), suites, only);
  const replayedMatches = selectCases(replayedCorpus(full), suites, only);
  if (only && recordedMatches.length > 0 && replayedMatches.length === 0) {
    throw new Error(`SHIP_GATE_PARITY_CASES=${only} matches ${recordedMatches.length} recorded cases and the sample dropped all of them; set SHIP_GATE_PARITY_FULL=1 to replay them`);
  }
  const report: ShipGateParityReport = { cases: 0, recorded: shardCases(recordedMatches, shard).length, sampled: !full, mismatches: 0, perSuite: new Map(), details: [] };
  replayEach(shardCases(replayedMatches, shard), (testCase, run, root) => {
    const problems = judgeCase(testCase.expected, run, root);
    report.cases += 1;
    report.perSuite.set(testCase.suite, (report.perSuite.get(testCase.suite) ?? 0) + 1);
    if (problems.length > 0) {
      report.mismatches += 1;
      report.details.push(`case ${testCase.id} (${testCase.test}) stdin ${excerpt(restored(testCase.stdin, root))}:\n  ${problems.join("\n  ")}`);
    }
  });
  return report;
}

export function goldenDeltas(cases: readonly RecordedCase[]): Map<string, ObservedDelta> {
  const deltas = new Map<string, ObservedDelta>();
  replayEach(cases, (testCase, run, root) => deltas.set(testCase.id, goldenOf(run, root)));
  return deltas;
}

function replayEach(cases: readonly RecordedCase[], visit: (testCase: RecordedCase, run: Run, root: string) => void): void {
  const store = loadStore();
  const root = paddedRoot(realpathSync(tmpdir()), store.rootLength);
  try {
    for (const testCase of cases) visit(testCase, replay(testCase, store, root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function recordedCorpus(): RecordedCase[] {
  return loadRecordedCases();
}

export function replayedCorpus(full: boolean = fullCorpusRequested()): RecordedCase[] {
  const recorded = loadRecordedCases();
  return full ? recorded : sampleCorpus(recorded, loadStore());
}

export function shardCases(cases: readonly RecordedCase[], shard: Shard): RecordedCase[] {
  return cases.filter((_testCase, position) => position % shard.count === shard.index);
}

function selectedSuites(): readonly Suite[] {
  const chosen = process.env["SHIP_GATE_PARITY_SUITES"];
  if (!chosen) return SUITES;
  return chosen.split(",").map((name) => {
    if (!(SUITES as readonly string[]).includes(name)) throw new Error(`unknown parity suite ${name}`);
    return name as Suite;
  });
}

export function fullCorpusRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SHIP_GATE_PARITY_FULL"] === "1";
}

export function loadStore(): RecordedStore {
  return JSON.parse(readFixtureFile(FIXTURE_DIRECTORY, "snapshots.json")) as RecordedStore;
}

function loadRecordedCases(): RecordedCase[] {
  const lines = readFixtureFile(FIXTURE_DIRECTORY, "cases.jsonl").split("\n").filter((line) => line !== "");
  return lines.map((line) => JSON.parse(line) as RecordedCase);
}

function selectCases(cases: readonly RecordedCase[], suites: readonly Suite[], only?: string): RecordedCase[] {
  return cases.filter((testCase) => suites.includes(testCase.suite) && (!only || new RegExp(only).test(testCase.id)));
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

function checkoutRepoKey(): string | null {
  try {
    return normalizeRepoKey(execFileSync("git", ["-C", KEEL_HOME, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return null;
  }
}

export function withoutCheckoutRepoKey(content: string, repoKey: string | null): string {
  const recorded = content.replaceAll(RECORDED_CHECKOUT_REPO_KEY, CHECKOUT_REPO_TOKEN);
  return repoKey === null || repoKey === "" ? recorded : recorded.replaceAll(repoKey, CHECKOUT_REPO_TOKEN);
}

function normalized(key: string, content: string): string {
  if (key.endsWith(CC_VERSION_FILE)) return CC_VERSION_PLACEHOLDER;
  if (!key.endsWith(FIRES_LOG_NAME)) return content;
  return withoutCheckoutRepoKey(comparableFires(content), CHECKOUT_REPO_KEY);
}

function decodeWordingMasked(text: string): string {
  return text.replace(DECODE_DETAIL, DECODE_DETAIL_MASKED).replace(EVIDENCE_DECODE_DETAIL, EVIDENCE_DECODE_DETAIL_MASKED);
}

function comparableFires(content: string): string {
  return content.split("\n").map((line) => (line === "" ? line : comparableFiresLine(line))).join("\n");
}

function comparableFiresLine(line: string): string {
  const masked = line.replace(CC_VERSION_FIELD, `cc_version=${CC_VERSION_PLACEHOLDER}`);
  let record: unknown;
  try {
    record = JSON.parse(Buffer.from(masked, "latin1").toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return masked;
  }
  if (!isJsonObject(record)) return masked;
  if (typeof record["detail"] === "string") record["detail"] = decodeWordingMasked(record["detail"]);
  if ("ts" in record) record["ts"] = TIMESTAMP_PLACEHOLDER;
  return stringifySorted(record);
}

function comparableRun(run: Run): Run {
  return { ...run, observation: { ...run.observation, stderr: decodeWordingMasked(run.observation.stderr) } };
}

export function goldenOf(run: Run, root: string): ObservedDelta {
  return deltaOf(root, comparableRun(run));
}

export function judgeCase(expected: ObservedDelta, run: Run, root: string): string[] {
  return differencesFromRecorded(expected, comparableRun(run), root, GOLDEN_LABEL);
}

export function summary(report: ShipGateParityReport): string[] {
  if (!report.sampled) return [`golden: ${report.cases} cases, ${report.mismatches} mismatches`];
  return [`golden: ${report.cases} of ${report.recorded} cases (sample), ${report.mismatches} mismatches`];
}

if (import.meta.main) {
  const report = runShipGateParity();
  for (const detail of report.details.slice(0, MAX_MISMATCHES_SHOWN)) console.log(detail);
  console.log(JSON.stringify({ perSuite: Object.fromEntries(report.perSuite) }));
  for (const line of summary(report)) console.log(line);
  process.exitCode = report.mismatches === 0 ? 0 : 1;
}
