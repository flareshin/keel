import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { withoutLocale } from "./locale-env.ts";

const ADAPTER = join(import.meta.dirname, "..");
const PYTHON_HOOK = join(ADAPTER, "hooks", "pre-tool-use.py");
const TYPESCRIPT_HOOK = join(ADAPTER, "hooks", "pre-tool-use.ts");
const NORMAL_CONFIG = "[features]\nhooks = true\n";
const MAX_MISMATCHES_SHOWN = 6;
const FLOAT_DIRECTORIES = ["1", "1.0", "100.0", "-0.0", "1e+16", "1e+22", "0.5", "2.5"];
const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?/g;

export interface HookCase {
  name: string;
  stdin: string | Buffer;
  config?: string | Buffer | null;
  crash?: boolean;
  env?: Record<string, string>;
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

interface Observation {
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
  contextual: number;
}

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
  for (const [name, value] of Object.entries(withoutLocale(process.env))) if (!name.startsWith("KEEL_") && !name.startsWith("CODEX_")) env[name] = value;
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

function observe(command: string[], testCase: HookCase, paths: Paths): Observation {
  buildSandbox(paths, testCase.config === undefined ? NORMAL_CONFIG : testCase.config);
  const result = spawnSync(command[0] as string, command.slice(1), { input: testCase.stdin, env: environmentFor(paths, testCase.env), cwd: paths.repo, maxBuffer: 1 << 26 });
  return { status: result.status, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"), files: snapshot(paths.root) };
}

function differences(testCase: HookCase, python: Observation, typescript: Observation): string[] {
  const found: string[] = [];
  if (python.status !== typescript.status) found.push(`exit ${python.status} vs ${typescript.status}`);
  if (python.stdout !== typescript.stdout) found.push(`stdout\n    py: ${JSON.stringify(python.stdout)}\n    ts: ${JSON.stringify(typescript.stdout)}`);
  if (!testCase.crash && python.stderr !== typescript.stderr) found.push(`stderr\n    py: ${JSON.stringify(python.stderr)}\n    ts: ${JSON.stringify(typescript.stderr)}`);
  if (testCase.crash && python.stderr === "") found.push("crash case produced no python error output");
  for (const key of new Set([...Object.keys(python.files), ...Object.keys(typescript.files)])) {
    if (python.files[key] !== typescript.files[key]) found.push(`file ${key}: py=${python.files[key]} ts=${typescript.files[key]}`);
  }
  return found;
}

export function runHookParity(cases: readonly HookCase[], paths: Paths): HookParityReport {
  const report: HookParityReport = { cases: cases.length, mismatches: 0, details: [], denied: 0, passed: 0, contextual: 0 };
  for (const testCase of cases) {
    const python = observe(["python3", PYTHON_HOOK], testCase, paths);
    const typescript = observe([process.execPath, TYPESCRIPT_HOOK], testCase, paths);
    const found = differences(testCase, python, typescript);
    if (found.length > 0) {
      report.mismatches += 1;
      if (report.details.length < MAX_MISMATCHES_SHOWN) report.details.push(`${testCase.name}: ${found.join("; ")}`);
    }
    if (python.stdout.includes('"permissionDecision": "deny"')) report.denied += 1;
    else if (python.stdout.includes("additionalContext")) report.contextual += 1;
    else report.passed += 1;
  }
  rmSync(paths.root, { recursive: true, force: true });
  return report;
}
