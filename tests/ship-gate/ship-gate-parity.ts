import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { copyTree } from "../hooks/hook-parity.ts";
import { KEEL_HOME } from "./helpers.ts";

const RECORDER = join(import.meta.dirname, "ship_gate_parity_record.py");
const SUITES = ["python-keel", "ts-keel", "message-contract", "extra"] as const;
const RUN_TIMEOUT_MS = 120_000;
const RECORD_TIMEOUT_MS = 60 * 60_000;
const MAX_MISMATCHES_SHOWN = 60;
const EXCERPT_CHARACTERS = 300;
const DENY_EXIT_CODE = 2;
const PASS_EXIT_CODE = 0;
const FIRES_LOG_NAME = "keel-fires.jsonl";
const FIRES_TIMESTAMP = /"ts": "[^"]*"/g;
const GIT_STATE = new Set(["HEAD", "config", "packed-refs", "FETCH_HEAD", "refs"]);
const UNREADABLE = "<unreadable>";

type Suite = (typeof SUITES)[number];
type Runtime = "python" | "node";

interface Case {
  id: string;
  suite: Suite;
  test: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  python: string;
  snapshot: string;
}

export interface Observation {
  code: number | null;
  stdout: string;
  stderr: string;
  files: Map<string, string>;
}

interface RecorderSummary {
  label: string;
  recorded: number;
  testsRun: number;
  failures: number;
  errors: number;
  skipped: number;
  seconds: number;
}

export interface ShipGateParityReport {
  cases: number;
  mismatches: number;
  denyToPass: number;
  perSuite: Map<string, number>;
  details: string[];
  recorders: RecorderSummary[];
}

export function runShipGateParity(suites: readonly Suite[] = selectedSuites()): ShipGateParityReport {
  const kept = process.env["SHIP_GATE_PARITY_DIR"];
  if (kept) mkdirSync(kept, { recursive: true });
  const base = kept ? realpathSync(kept) : realpathSync(mkdtempSync(join(tmpdir(), "keel-ship-gate-parity-")));
  try {
    const casesDir = join(base, "cases");
    const sandboxRoot = join(base, "sandbox");
    const report: ShipGateParityReport = { cases: 0, mismatches: 0, denyToPass: 0, perSuite: new Map(), details: [], recorders: [] };
    for (const suite of suites) {
      if (!hasRecorded(casesDir, suite)) report.recorders.push(record(suite, casesDir, sandboxRoot));
    }
    for (const testCase of loadCases(casesDir)) {
      const expected = observe(testCase, sandboxRoot, "python");
      const actual = observe(testCase, sandboxRoot, "node");
      const differences = compare(expected, actual);
      report.cases += 1;
      report.perSuite.set(testCase.suite, (report.perSuite.get(testCase.suite) ?? 0) + 1);
      if (isDenyToPass(expected, actual)) report.denyToPass += 1;
      if (differences.length > 0) {
        report.mismatches += 1;
        report.details.push(`case ${testCase.id} (${testCase.test}) stdin ${excerpt(testCase.stdin)}:\n  ${differences.join("\n  ")}`);
      }
    }
    return report;
  } finally {
    if (!kept) rmSync(base, { recursive: true, force: true });
  }
}

function hasRecorded(casesDir: string, suite: Suite): boolean {
  return existsSync(casesDir) && readdirSync(casesDir).some((id) => id.startsWith(suite + "-"));
}

function selectedSuites(): readonly Suite[] {
  const chosen = process.env["SHIP_GATE_PARITY_SUITES"];
  if (!chosen) return SUITES;
  return chosen.split(",").map((name) => {
    if (!(SUITES as readonly string[]).includes(name)) throw new Error(`unknown parity suite ${name}`);
    return name as Suite;
  });
}

function record(suite: Suite, casesDir: string, sandboxRoot: string): RecorderSummary {
  const result = spawnSync("python3", [RECORDER, casesDir, sandboxRoot, suite], {
    encoding: "utf8", timeout: RECORD_TIMEOUT_MS, maxBuffer: 1 << 28,
  });
  if (result.status !== 0) throw new Error(`recording the ${suite} payloads failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

function loadCases(casesDir: string): Case[] {
  const only = process.env["SHIP_GATE_PARITY_CASES"];
  return readdirSync(casesDir).sort().filter((id) => !only || new RegExp(only).test(id)).map((id) => {
    const directory = join(casesDir, id);
    const recorded = JSON.parse(readFileSync(join(directory, "case.json"), "utf8"));
    return { id, suite: id.slice(0, id.lastIndexOf("-")), ...recorded, snapshot: join(directory, "root") } as Case;
  });
}

function observe(testCase: Case, sandboxRoot: string, runtime: Runtime): Observation {
  rmSync(sandboxRoot, { recursive: true, force: true });
  copyTree(testCase.snapshot, sandboxRoot);
  const entry = join(KEEL_HOME, runtime === "python" ? testCase.script : testCase.script.replace(/\.py$/, ".ts"));
  const command = runtime === "python" ? testCase.python : process.execPath;
  const completed = spawnSync(command, [entry, ...testCase.args], {
    input: testCase.stdin, encoding: "utf8", env: testCase.env, cwd: testCase.cwd, timeout: RUN_TIMEOUT_MS,
  });
  const observation = { code: completed.status, stdout: completed.stdout, stderr: completed.stderr, files: readTree(sandboxRoot) };
  rmSync(sandboxRoot, { recursive: true, force: true });
  return observation;
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

export function compare(expected: Observation, actual: Observation): string[] {
  const differences: string[] = [];
  for (const field of ["code", "stdout", "stderr"] as const) {
    if (expected[field] !== actual[field]) differences.push(`${field}: python ${excerpt(expected[field])} / node ${excerpt(actual[field])}`);
  }
  for (const key of new Set([...expected.files.keys(), ...actual.files.keys()])) {
    const python = expected.files.get(key);
    const node = actual.files.get(key);
    if (python !== node) differences.push(`file ${key}: python ${excerpt(python)} / node ${excerpt(node)}`);
  }
  return differences;
}

export function isDenyToPass(expected: Observation, actual: Observation): boolean {
  return expected.code === DENY_EXIT_CODE && actual.code === PASS_EXIT_CODE;
}

function excerpt(value: unknown): string {
  if (value === undefined) return "<absent>";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > EXCERPT_CHARACTERS ? text.slice(0, EXCERPT_CHARACTERS) + "…" : text;
}

export function summary(report: ShipGateParityReport): string[] {
  return [`parity: ${report.cases} cases, ${report.mismatches} mismatches`, `deny-to-pass: ${report.denyToPass}`];
}

if (import.meta.main) {
  const report = runShipGateParity();
  for (const detail of report.details.slice(0, MAX_MISMATCHES_SHOWN)) console.log(detail);
  console.log(JSON.stringify({ perSuite: Object.fromEntries(report.perSuite), recorders: report.recorders }));
  for (const line of summary(report)) console.log(line);
  process.exitCode = report.mismatches === 0 && report.denyToPass === 0 ? 0 : 1;
}
