import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { recordedAnswers } from "../../tests/recorded.ts";
import { ROOT_TOKEN } from "../../tests/recorded-cases.ts";
import { fineClass, HOOK_NAME, sampleCases } from "./hook-parity-sample.ts";

const ADAPTER = join(import.meta.dirname, "..");
const TYPESCRIPT_HOOK = join(ADAPTER, "hooks", "pre-tool-use.ts");
const WORKER = join(import.meta.dirname, "hook-parity-worker.ts");
export const GOLDEN_DOCUMENT = "codex-hook-parity";
const MAX_WORKERS = 8;
const NORMAL_CONFIG = "[features]\nhooks = true\n";
const MAX_MISMATCHES_SHOWN = 6;
const FLOAT_DIRECTORIES = ["1", "1.0", "100.0", "-0.0", "1e+16", "1e+22", "0.5", "2.5"];
const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?/g;
const CRASH_LINE = /^\w*Error: .*$/m;
const DENY_DECISION = /"permissionDecision":"deny"/;
const SYNTAX_MESSAGE = /(invalid JSON: )(?:[^"\\]|\\.)*/g;
const SYNTAX_MESSAGE_MASKED = "$1<JSON syntax error message>";

export type WorkerMode = "check" | "record";

export interface HookCase {
  name: string;
  stdin: string | Buffer;
  config?: string | Buffer | null;
  crash?: boolean;
  env?: Record<string, string>;
}

export interface ParitySummary {
  cases: number;
  corpus: number;
  mismatches: number;
  sampled: boolean;
}

export interface Paths {
  root: string;
  profile: string;
  agents: string;
  home: string;
  aliases: string;
  repo: string;
  data: string;
  overlay: string;
  accountHome: string;
}

export interface Observation {
  status: number | null;
  stdout: string;
  stderr: string;
  files: Record<string, string>;
}

export interface HookParityReport {
  cases: number;
  mismatches: number;
  details: string[];
  denied: number;
  passed: number;
}

export type GoldenEntry = [question: unknown, golden: Observation];

export function sandboxPaths(): Paths {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-hook-parity-")));
  return {
    root, profile: join(root, "profile"), agents: join(root, "agents"), home: join(root, "home"), aliases: join(root, "aliases"),
    repo: join(root, "repo"), data: join(root, "data"), overlay: join(root, "overlay"), accountHome: userInfo().homedir,
  };
}

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function buildSandbox(paths: Paths, config: string | Buffer | null): void {
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.root);
  if (config !== null) put(join(paths.profile, "config.toml"), config);
  mkdirSync(paths.profile, { recursive: true });
  put(join(paths.profile, "AGENTS.md"), "agents\n");
  put(join(paths.profile, "hooks.json"), "{}\n");
  put(join(paths.profile, "keel-codex-state.json"), "{}\n");
  put(join(paths.profile, "sessions/2026/10/16/review.jsonl"), "record\n");
  put(join(paths.profile, "archived_sessions/a.jsonl"), "record\n");
  put(join(paths.profile, "notes.txt"), "notes\n");
  put(join(paths.agents, "keel-codex-skills.json"), "{}\n");
  mkdirSync(join(paths.agents, "skills"));
  put(join(paths.home, ".codex/sessions/r.jsonl"), "record\n");
  mkdirSync(paths.aliases);
  symlinkSync(join(paths.profile, "sessions"), join(paths.aliases, "session-link"));
  symlinkSync(paths.profile, join(paths.aliases, "profile-alias"));
  symlinkSync(join(paths.aliases, "nowhere"), join(paths.aliases, "dangling"));
  mkdirSync(paths.repo);
  for (const name of FLOAT_DIRECTORIES) {
    mkdirSync(join(paths.repo, name));
    if (name !== "1") symlinkSync(join(paths.profile, "hooks.json"), join(paths.repo, name, "hj"));
  }
  mkdirSync(paths.data);
  mkdirSync(paths.overlay);
  put(join(paths.root, "gitconfig"), "[user]\n\tname = parity\n\temail = parity@localhost\n");
  spawnSync("git", ["init", "-q", paths.repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: join(paths.root, "gitconfig") } });
  put(join(paths.repo, "README"), "x\n");
}

function environmentFor(paths: Paths, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("KEEL_") && !name.startsWith("CODEX_")) env[name] = value;
  return {
    ...env, HOME: paths.home, KEEL_CODEX_HOME: paths.profile, KEEL_AGENTS_HOME: paths.agents, KEEL_DATA_DIR: paths.data,
    KEEL_OVERLAY_DIR: paths.overlay, GIT_CONFIG_GLOBAL: join(paths.root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", ...extra,
  };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = path.slice(root.length + 1);
      if (relative === "repo/.git") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) files[relative] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        files[relative] = "dir";
        walk(path);
      } else files[relative] = `file:${(stat.mode & 0o777).toString(8)}:${readFileSync(path).toString("latin1")}`;
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.replace(TIMESTAMP, "<time>")]));
}

function configOf(testCase: HookCase): string | Buffer | null {
  return testCase.config === undefined ? NORMAL_CONFIG : testCase.config;
}

function sandboxFiles(paths: Paths): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshot(paths.root)).map(([key, content]): [string, string] => [key, withSyntaxMessageMasked(content)]));
}

function observe(testCase: HookCase, paths: Paths): Observation {
  buildSandbox(paths, configOf(testCase));
  const result = spawnSync(process.execPath, [TYPESCRIPT_HOOK], { input: testCase.stdin, env: environmentFor(paths, testCase.env), cwd: paths.repo, maxBuffer: 1 << 26 });
  const stderr = result.stderr.toString("utf8");
  return { status: result.status, stdout: withSyntaxMessageMasked(result.stdout.toString("utf8")), stderr: testCase.crash ? crashLine(stderr) : stderr, files: sandboxFiles(paths) };
}

export function withSyntaxMessageMasked(text: string): string {
  return text.replace(SYNTAX_MESSAGE, SYNTAX_MESSAGE_MASKED);
}

export function crashLine(stderr: string): string {
  return CRASH_LINE.exec(stderr)?.[0] ?? stderr;
}

function questionText(content: string | Buffer | null | undefined): unknown {
  if (content === undefined || content === null) return content ?? null;
  return typeof content === "string" ? content : { latin1: content.toString("latin1") };
}

function questionOf(testCase: HookCase): unknown {
  return { name: testCase.name, stdin: questionText(testCase.stdin), config: testCase.config === undefined ? "default" : questionText(testCase.config), env: testCase.env ?? {} };
}

function rootTokenized<Value>(value: Value, root: string): Value {
  return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(root).slice(1, -1), ROOT_TOKEN)) as Value;
}

function goldenObservations(cases: readonly HookCase[], paths: Paths): Observation[] {
  return recordedAnswers<unknown, Observation>(GOLDEN_DOCUMENT, cases.map(questionOf), { [ROOT_TOKEN]: paths.root });
}

function goldenObservation(testCase: HookCase, paths: Paths): Observation {
  return goldenObservations([testCase], paths)[0] as Observation;
}

export function fullCorpusRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CODEX_HOOK_PARITY_FULL"] === "1";
}

export function selectedCases(cases: readonly HookCase[], paths: Paths, full: boolean = fullCorpusRequested()): HookCase[] {
  return full ? [...cases] : sampleCases(cases, (sampled) => outcomeClasses(sampled, paths));
}

export function outcomeClasses(cases: readonly HookCase[], paths: Paths): string[] {
  const baselines = new Map<string, Record<string, string>>();
  const baselineOf = (testCase: HookCase): Record<string, string> => {
    const config = configOf(testCase);
    const key = JSON.stringify(questionText(config));
    if (!baselines.has(key)) {
      buildSandbox(paths, config);
      baselines.set(key, sandboxFiles(paths));
    }
    return baselines.get(key) as Record<string, string>;
  };
  const goldens = goldenObservations(cases, paths);
  const classes = cases.map((testCase, position) => fineClass(HOOK_NAME, goldens[position] as Observation, baselineOf(testCase)));
  rmSync(paths.root, { recursive: true, force: true });
  return classes;
}

export function summary(replayed: ParitySummary): string {
  if (!replayed.sampled) return `golden: ${replayed.cases} cases, ${replayed.mismatches} mismatches`;
  return `golden: ${replayed.cases} of ${replayed.corpus} cases (sample), ${replayed.mismatches} mismatches`;
}

export function differences(golden: Observation, node: Observation): string[] {
  const found: string[] = [];
  if (golden.status !== node.status) found.push(`exit golden ${golden.status} / node ${node.status}`);
  if (golden.stdout !== node.stdout) found.push(`stdout\n    golden: ${JSON.stringify(golden.stdout)}\n    node: ${JSON.stringify(node.stdout)}`);
  if (golden.stderr !== node.stderr) found.push(`stderr\n    golden: ${JSON.stringify(golden.stderr)}\n    node: ${JSON.stringify(node.stderr)}`);
  for (const key of new Set([...Object.keys(golden.files), ...Object.keys(node.files)])) {
    if (golden.files[key] !== node.files[key]) found.push(`file ${key}: golden=${golden.files[key]} node=${node.files[key]}`);
  }
  return found;
}

export function runHookParity(cases: readonly HookCase[], paths: Paths): HookParityReport {
  const report: HookParityReport = { cases: cases.length, mismatches: 0, details: [], denied: 0, passed: 0 };
  for (const testCase of cases) {
    const golden = goldenObservation(testCase, paths);
    const node = observe(testCase, paths);
    const found = differences(golden, node);
    if (found.length > 0) {
      report.mismatches += 1;
      if (report.details.length < MAX_MISMATCHES_SHOWN) report.details.push(`${testCase.name}: ${found.join("; ")}`);
    }
    if (DENY_DECISION.test(golden.stdout)) report.denied += 1;
    else report.passed += 1;
    if (testCase.crash === true && golden.stderr === "") {
      report.mismatches += 1;
      report.details.push(`${testCase.name}: crash case recorded no error output`);
    }
  }
  rmSync(paths.root, { recursive: true, force: true });
  return report;
}

export function goldenEntries(cases: readonly HookCase[], paths: Paths): GoldenEntry[] {
  const entries = cases.map((testCase): GoldenEntry => [
    rootTokenized(questionOf(testCase), paths.root), rootTokenized(observe(testCase, paths), paths.root),
  ]);
  rmSync(paths.root, { recursive: true, force: true });
  return entries;
}

function runWorker<Result>(mode: WorkerMode, index: number, count: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, mode, String(index), String(count)]);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => (status === 0 ? resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Result) : reject(new Error(stderr))));
  });
}

export function inWorkers<Result>(mode: WorkerMode): Promise<Result[]> {
  const workers = Math.min(MAX_WORKERS, availableParallelism());
  return Promise.all(Array.from({ length: workers }, (_unused, index) => runWorker<Result>(mode, index, workers)));
}
