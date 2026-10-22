import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { KEEL_HOME } from "./helpers.ts";
import type { HookSandbox } from "./helpers.ts";
import { buildAdversarialSet } from "./hook-parity-adversarial.ts";
import type { AdversarialCase } from "./hook-parity-adversarial.ts";

const RECORDER = join(import.meta.dirname, "hook_parity_record.py");
const RUN_TIMEOUT_MS = 60_000;
const RECORD_TIMEOUT_MS = 20 * 60_000;
const MAX_MISMATCHES_SHOWN = 12;
const EXCERPT_CHARACTERS = 240;
const FIRES_TIMESTAMP = /^(\{"ts": ")[^"]*(")/;
const HANDOFF_TIMESTAMP = /^(> Generated )\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /m;
const UNREADABLE = "<unreadable>";
const GIT_DIRECTORY = ".git";
const REMOTES_TREE = "remotes";

interface Case {
  id: string;
  test: string;
  script: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  python: string;
  snapshot: string;
  root: string;
}

interface Observation {
  code: number | null;
  stdout: string;
  stderr: string;
  files: Map<string, string>;
}

export interface ParityReport {
  cases: number;
  adversarial: number;
  mismatches: number;
  perHook: Map<string, number>;
  details: string[];
  recorder: { recorded: number; testsRun: number; failures: number; errors: number; skipped: number };
}

export function runParity(): ParityReport {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keel-parity-")));
  const adversarial = buildAdversarialSet();
  try {
    const casesDir = join(base, "cases");
    const sandboxRoot = join(base, "sandbox");
    const recorder = record(casesDir, sandboxRoot);
    const report: ParityReport = { cases: 0, adversarial: 0, mismatches: 0, perHook: new Map(), details: [], recorder };
    for (const testCase of loadCases(casesDir, sandboxRoot)) replay(testCase, report);
    for (const testCase of snapshotAdversarialCases(adversarial, join(base, "adversarial"))) {
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
  const expected = observe(testCase, "python");
  const actual = observe(testCase, "node");
  const differences = compare(expected, actual);
  report.cases += 1;
  report.perHook.set(testCase.script, (report.perHook.get(testCase.script) ?? 0) + 1);
  if (differences.length > 0) {
    report.mismatches += 1;
    report.details.push(`case ${testCase.id} (${testCase.test}) ${testCase.script}:\n  ${differences.join("\n  ")}`);
  }
}

function snapshotAdversarialCases(adversarial: { sandbox: HookSandbox; cases: AdversarialCase[] }, snapshot: string): Case[] {
  const sandbox = adversarial.sandbox;
  copyTree(sandbox.root, snapshot);
  return adversarial.cases.map((adversarialCase, index) => ({
    id: `adversarial-${String(index + 1).padStart(4, "0")}`, test: adversarialCase.name, script: adversarialCase.script,
    args: adversarialCase.args, cwd: adversarialCase.cwd, stdin: adversarialCase.stdin, env: sandbox.env, python: "python3",
    snapshot, root: sandbox.root,
  }));
}

function record(casesDir: string, sandboxRoot: string): ParityReport["recorder"] {
  const result = spawnSync("python3", [RECORDER, casesDir, sandboxRoot], { encoding: "utf8", timeout: RECORD_TIMEOUT_MS, maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`recording the Python hook tests failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

function loadCases(casesDir: string, sandboxRoot: string): Case[] {
  return readdirSync(casesDir).sort().map((id) => {
    const directory = join(casesDir, id);
    const recorded = JSON.parse(readFileSync(join(directory, "case.json"), "utf8"));
    return { id, ...recorded, snapshot: join(directory, "root"), root: sandboxRoot } as Case;
  });
}

function observe(testCase: Case, runtime: "python" | "node"): Observation {
  const sandboxRoot = testCase.root;
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

function readTree(root: string): Map<string, string> {
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
  if (key === join("data", "logs", "keel-fires.jsonl")) {
    return content.split("\n").map((line) => line.replace(FIRES_TIMESTAMP, "$1<ts>$2")).join("\n");
  }
  if (key.startsWith(join("data", "handoff") + "/")) return content.replace(HANDOFF_TIMESTAMP, "$1<ts> ");
  return content;
}

function compare(expected: Observation, actual: Observation): string[] {
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

function excerpt(value: unknown): string {
  if (value === undefined) return "<absent>";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > EXCERPT_CHARACTERS ? text.slice(0, EXCERPT_CHARACTERS) + "…" : text;
}

export function summary(report: ParityReport): string {
  return `parity: ${report.cases - report.adversarial} recorded + ${report.adversarial} adversarial cases, ${report.mismatches} mismatches`;
}

if (import.meta.main) {
  const report = runParity();
  for (const detail of report.details.slice(0, MAX_MISMATCHES_SHOWN)) console.log(detail);
  console.log(JSON.stringify({ perHook: Object.fromEntries(report.perHook), recorder: report.recorder }));
  console.log(summary(report));
  process.exitCode = report.mismatches === 0 ? 0 : 1;
}
