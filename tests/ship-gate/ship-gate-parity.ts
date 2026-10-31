import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deltaOf, differencesFromRecorded, envFromTemplate, excerpt, materialize, paddedRoot, readFixtureFile, restored, runInSandbox } from "../recorded-cases.ts";
import type { Observation, ObservedDelta, Run, SnapshotStore } from "../recorded-cases.ts";
import { normalizeRepoKey } from "../../lib/evidence/registry.ts";
import { isJsonObject, stringifySorted } from "../../measure/lib/measurekit/json.ts";
import { KEEL_HOME } from "./helpers.ts";

export const FIXTURE_DIRECTORY = join(import.meta.dirname, "fixtures", "ship-gate-parity");
export const SUITES = ["python-keel", "ts-keel", "message-contract", "extra"] as const;
const RUN_TIMEOUT_MS = 120_000;
const MAX_MISMATCHES_SHOWN = 60;
const DENY_EXIT_CODE = 2;
const FIRES_LOG_NAME = "keel-fires.jsonl";
const TIMESTAMP_PLACEHOLDER = "<ts>";
const DECODE_DETAIL = /\b(?:JSONDecodeError|JsonSyntaxError): [^\n]*/g;
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
const RULE_TAG = /\[[A-Za-z][\w.-]*\]/g;
const FIRE_SHAPE_FIELDS = ["rule_id", "hook", "outcome"];
const OVER_BOUND_NESTINGS = [10001, 200000];
const OVER_BOUND_KINDS = ["gh-answer", "evidence-file", "stdin-push", "stdin-ls"];
const COMMAND_DIVERGENT_NESTINGS = [9999, 10001];
const PYTHON_COMMENT_DELETION_TESTS = ["0003", "0469", "0470", "0474", "0475", "0476", "0477"];
const PYTHON_COMMENT_DELETION_SUITES = ["python-keel", "ts-keel"];
const GH_NUMBER_PAST_PYTHON_DIGIT_LIMIT = ["extra-0526", "extra-0527", "extra-0531", "extra-0532", "extra-0536"];
const PASS_EXIT_CODE = 0;
const NON_FINITE_PUSH_PAYLOAD = "extra-0018";
const NON_FINITE_GH_ANSWER_ON_A_PASSING_MERGE = "extra-0518";
const READ_PAST_PYTHON_DIGIT_LIMIT_ON_A_PUSH = ["extra-0025", "extra-0026", "extra-0030", "extra-0031", "extra-0035"];
const READ_PAST_PYTHON_DIGIT_LIMIT_ON_A_NON_PUSH = ["extra-0036", "extra-0037", "extra-0041", "extra-0042", "extra-0046", "extra-0062"];
const NON_FINITE_NON_PUSH_PAYLOADS = ["extra-0019", "extra-0020"];
const NON_FINITE_GH_ANSWERS_ON_A_DENIED_MERGE = ["extra-0514", "extra-0517"];
const UTF8_WORDING_ON_A_DENY = ["extra-0539", "extra-0540", "extra-0602"];
const REGISTRY_HEADER_NAMES_EVERY_OPTIONAL_COLUMN = ["extra-0603"];
const JSON_QUOTING_ON_A_DENY = ["extra-0549", "extra-0560", "extra-0562", "extra-0563", "extra-0565", "extra-0604", "extra-0605",
  "python-keel-0119", "ts-keel-0119"];
const JSON_QUOTING_ON_A_PASS = ["extra-0561", "extra-0564"];
const SYSTEM_ERROR_WORDING_ON_A_DENY = ["extra-0543", "extra-0544", "extra-0545", "extra-0548", "extra-0634", "extra-0635", "extra-0637",
  ...["python-keel", "ts-keel"].flatMap((suite) => ["0027", "0028", "0029", "0030", "0031", "0046", "0047"].map((number) => `${suite}-${number}`))];
const SYSTEM_ERROR_WORDING_ON_A_PASS = ["extra-0610", "extra-0632", "python-keel-0033", "ts-keel-0033"];
const rowIds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_unused, index) => `extra-${String(from + index).padStart(4, "0")}`);
const COMMAND_NOT_TEXT_FAILS_CLOSED = ["extra-0063", "extra-0066", "extra-0070"];
const COMMAND_NOT_TEXT_ON_A_DENIED_PUSH = ["extra-0051", "extra-0052"];
const COMMAND_NOT_TEXT_ON_A_NON_PUSH = ["extra-0064", "extra-0068", "extra-0069"];
const CWD_NOT_TEXT_WORDING = ["extra-0077", "extra-0078", "extra-0086", "extra-0087"];
const SESSION_NOT_TEXT_LOGGED_AS_DASH_ON_A_DENY = ["extra-0097", "extra-0100", "extra-0103", "extra-0115", "extra-0118"];
const SESSION_NOT_TEXT_LOGGED_AS_DASH_ON_A_PASS = ["extra-0098", "extra-0099", "extra-0101", "extra-0102", "extra-0104", "extra-0105", "extra-0116", "extra-0117", "extra-0119", "extra-0120", "extra-0558", "extra-0559"];
const GH_ANSWER_NOT_TEXT_WORDING_ON_A_DENY = [...rowIds(449, 456), ...rowIds(465, 468), ...rowIds(479, 482), "extra-0493", "extra-0494", "extra-0497", "extra-0498", ...rowIds(503, 506)];
const GH_ANSWER_NOT_TEXT_NOW_DENIED = [...rowIds(469, 472), ...rowIds(489, 492)];
const SUBMODULE_TESTS_COVER_A_DENIED_POINTER_PUSH = ["extra-0800"];
const STACKED_DISJOINT_HUNKS_OF_ONE_FILE_NOW_PASS = ["python-keel", "ts-keel"].flatMap((suite) => ["0460", "0462", "0466"].map((number) => `${suite}-${number}`));

export const EXPECTED_DIVERGENCES: ReadonlyMap<string, number> = new Map([
  ...OVER_BOUND_NESTINGS.flatMap((depth) => OVER_BOUND_KINDS.map((kind): [string, number] => [`${kind}-nested-${depth}`, DENY_EXIT_CODE])),
  ...COMMAND_DIVERGENT_NESTINGS.map((depth): [string, number] => [`command-list-nested-${depth}`, DENY_EXIT_CODE]),
  ...PYTHON_COMMENT_DELETION_SUITES.flatMap((suite) => PYTHON_COMMENT_DELETION_TESTS.map((number): [string, number] => [`py-comment-deletion-${suite}-${number}`, DENY_EXIT_CODE])),
  ...[...GH_NUMBER_PAST_PYTHON_DIGIT_LIMIT, ...READ_PAST_PYTHON_DIGIT_LIMIT_ON_A_NON_PUSH, ...NON_FINITE_NON_PUSH_PAYLOADS, ...JSON_QUOTING_ON_A_PASS,
    ...SYSTEM_ERROR_WORDING_ON_A_PASS, ...COMMAND_NOT_TEXT_ON_A_NON_PUSH, ...SESSION_NOT_TEXT_LOGGED_AS_DASH_ON_A_PASS, ...STACKED_DISJOINT_HUNKS_OF_ONE_FILE_NOW_PASS]
    .map((id): [string, number] => [id, PASS_EXIT_CODE]),
  ...[NON_FINITE_PUSH_PAYLOAD, NON_FINITE_GH_ANSWER_ON_A_PASSING_MERGE, ...READ_PAST_PYTHON_DIGIT_LIMIT_ON_A_PUSH, ...NON_FINITE_GH_ANSWERS_ON_A_DENIED_MERGE,
    ...UTF8_WORDING_ON_A_DENY, ...REGISTRY_HEADER_NAMES_EVERY_OPTIONAL_COLUMN, ...JSON_QUOTING_ON_A_DENY, ...SYSTEM_ERROR_WORDING_ON_A_DENY, ...COMMAND_NOT_TEXT_FAILS_CLOSED, ...COMMAND_NOT_TEXT_ON_A_DENIED_PUSH,
    ...CWD_NOT_TEXT_WORDING, ...SESSION_NOT_TEXT_LOGGED_AS_DASH_ON_A_DENY, ...GH_ANSWER_NOT_TEXT_WORDING_ON_A_DENY, ...GH_ANSWER_NOT_TEXT_NOW_DENIED,
    ...SUBMODULE_TESTS_COVER_A_DENIED_POINTER_PUSH]
    .map((id): [string, number] => [id, DENY_EXIT_CODE]),
]);

export const DECISION_PATH_CHANGED: ReadonlySet<string> = new Set([
  ...NON_FINITE_NON_PUSH_PAYLOADS, ...READ_PAST_PYTHON_DIGIT_LIMIT_ON_A_PUSH, ...COMMAND_NOT_TEXT_ON_A_DENIED_PUSH, ...COMMAND_NOT_TEXT_ON_A_NON_PUSH,
  ...SUBMODULE_TESTS_COVER_A_DENIED_POINTER_PUSH,
  "extra-0036", "extra-0037", "extra-0041", "extra-0042", "extra-0046",
  "stdin-push-nested-10001", "command-list-nested-9999", "command-list-nested-10001",
  ...PYTHON_COMMENT_DELETION_SUITES.flatMap((suite) => ["0470", "0477"].map((number) => `py-comment-deletion-${suite}-${number}`)),
]);

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
  mismatches: number;
  listedDivergences: number;
  denyToPass: number;
  perSuite: Map<string, number>;
  details: string[];
}

export function runShipGateParity(shard: Shard = WHOLE_CORPUS, suites: readonly Suite[] = selectedSuites()): ShipGateParityReport {
  const store = JSON.parse(readFixtureFile(FIXTURE_DIRECTORY, "snapshots.json")) as RecordedStore;
  const root = paddedRoot(realpathSync(tmpdir()), store.rootLength);
  const report: ShipGateParityReport = { cases: 0, mismatches: 0, listedDivergences: 0, denyToPass: 0, perSuite: new Map(), details: [] };
  const cases = shardCases(loadCases(suites, process.env["SHIP_GATE_PARITY_CASES"]), shard);
  try {
    for (const testCase of cases) {
      const run = replay(testCase, store, root);
      const label = labelOf(testCase);
      const verdict = judgeCase(label, testCase.expected, run, root);
      report.cases += 1;
      report.perSuite.set(testCase.suite, (report.perSuite.get(testCase.suite) ?? 0) + 1);
      if (!verdict.listed && isDenyToPass(testCase.expected, run.observation)) report.denyToPass += 1;
      if (verdict.listed) report.listedDivergences += 1;
      if (verdict.problems.length > 0) {
        report.mismatches += 1;
        report.details.push(`case ${testCase.id} (${testCase.test}) stdin ${excerpt(restored(testCase.stdin, root))}:\n  ${verdict.problems.join("\n  ")}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (shard === WHOLE_CORPUS && suites.includes("extra") && !process.env["SHIP_GATE_PARITY_CASES"]) {
    for (const problem of divergenceRecordingProblems(cases)) {
      report.mismatches += 1;
      report.details.push(problem);
    }
  }
  return report;
}

export function recordedCorpus(): RecordedCase[] {
  return loadCases(SUITES);
}

export function shardCases(cases: readonly RecordedCase[], shard: Shard): RecordedCase[] {
  return cases.filter((_testCase, position) => position % shard.count === shard.index);
}

export function divergenceRecordingProblems(cases: readonly RecordedCase[]): string[] {
  const recordings = new Map<string, number>();
  for (const testCase of cases) recordings.set(labelOf(testCase), (recordings.get(labelOf(testCase)) ?? 0) + 1);
  return [...EXPECTED_DIVERGENCES.keys()]
    .filter((label) => recordings.get(label) !== 1)
    .map((label) => `expected divergence ${label} was recorded ${recordings.get(label) ?? 0} times, not once`);
}

function labelOf(testCase: RecordedCase): string {
  return testCase.label || testCase.id;
}

function selectedSuites(): readonly Suite[] {
  const chosen = process.env["SHIP_GATE_PARITY_SUITES"];
  if (!chosen) return SUITES;
  return chosen.split(",").map((name) => {
    if (!(SUITES as readonly string[]).includes(name)) throw new Error(`unknown parity suite ${name}`);
    return name as Suite;
  });
}

function loadCases(suites: readonly Suite[], only?: string): RecordedCase[] {
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

function comparableRecorded(expected: ObservedDelta): ObservedDelta {
  const set = Object.fromEntries(Object.entries(expected.set).map(([key, content]) => [key, key.endsWith(FIRES_LOG_NAME) ? comparableFires(content) : content]));
  return { ...expected, stderr: decodeWordingMasked(expected.stderr), set };
}

function comparableRun(run: Run): Run {
  return { ...run, observation: { ...run.observation, stderr: decodeWordingMasked(run.observation.stderr) } };
}

export interface Verdict {
  listed: boolean;
  problems: string[];
}

export function judgeCase(label: string, expected: ObservedDelta, run: Run, root: string): Verdict {
  const differences = differencesFromRecorded(comparableRecorded(expected), comparableRun(run), root);
  const required = EXPECTED_DIVERGENCES.get(label);
  const code = run.observation.code;
  if (required === undefined) return { listed: false, problems: differences };
  if (code !== required) return { listed: false, problems: [`listed divergence ${label} requires node exit ${required}, got ${code}`, ...differences] };
  const shapeProblems = expected.code === required && !DECISION_PATH_CHANGED.has(label) ? shapeDifferences(comparableRecorded(expected), deltaOf(root, run)) : [];
  return shapeProblems.length === 0 ? { listed: true, problems: [] } : { listed: false, problems: [...shapeProblems, ...differences] };
}

function shapeDifferences(expected: ObservedDelta, actual: ObservedDelta): string[] {
  const problems: string[] = [];
  const [expectedTags, actualTags] = [ruleTags(expected.stderr), ruleTags(actual.stderr)];
  if (expectedTags !== actualTags) problems.push(`rule tags on stderr: python ${expectedTags} / node ${actualTags}`);
  const [expectedFires, actualFires] = [fireShapes(expected), fireShapes(actual)];
  if (expectedFires !== actualFires) problems.push(`fires rule, hook and outcome: python ${expectedFires} / node ${actualFires}`);
  return problems;
}

function ruleTags(stderr: string): string {
  return JSON.stringify(stderr.split("\n").map((line) => line.match(RULE_TAG) ?? []));
}

function fireShapes(delta: ObservedDelta): string {
  const lines = Object.entries(delta.set).filter(([key]) => key.endsWith(FIRES_LOG_NAME)).flatMap(([, content]) => content.split("\n").filter((line) => line !== ""));
  return JSON.stringify(lines.map(fireShape));
}

function fireShape(line: string): string {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return line;
  }
  if (!isJsonObject(record)) return line;
  return FIRE_SHAPE_FIELDS.map((field) => String(record[field])).join(" ");
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
