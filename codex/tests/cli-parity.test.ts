import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { recordedAnswers } from "../../tests/recorded.ts";
import { withoutLocale } from "./locale-env.ts";

const ADAPTER = realpathSync(join(import.meta.dirname, ".."));
const HOOK_SCRIPT_PATH = /\S*codex\/hooks\/pre-tool-use\.(?:py|ts)/;
const RUNTIME_TOKEN = new RegExp(` \\S+ (?=${HOOK_SCRIPT_PATH.source})`, "g");
const HOOKS_JSON_DIGEST = /(\/hooks\.json": ")[0-9a-f]{64}(")/g;
const TEMPORARY_NAME = /(\/\.[A-Za-z0-9._-]+?)\.[a-z0-9_]{8}'/g;
const LOCK_ARTIFACT = /\.agents\/keel-codex-skills\.lock(?:\.d)?$/;
const MISMATCHES_SHOWN = 6;
const SHA256_HEX = /\b[0-9a-f]{64}\b/g;

interface Step {
  command: "link" | "config";
  args: string[];
  env?: Record<string, string>;
  before?: (root: string) => void;
}

interface Scenario {
  name: string;
  steps: Step[];
}

interface Observation {
  status: number | null;
  stdout: string;
  stderr: string;
  files: Record<string, string>;
}

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function normalizeHookCommand(text: string, implementation: "python" | "typescript"): string {
  const counterpart = implementation === "python" ? text.replaceAll("codex/hooks/pre-tool-use.py", "codex/hooks/pre-tool-use.ts") : text;
  return counterpart.replace(RUNTIME_TOKEN, " <runtime> ").replace(SHA256_HEX, "<sha256>");
}

function snapshot(root: string, implementation: "python" | "typescript"): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = path.slice(root.length + 1);
      if (LOCK_ARTIFACT.test(path)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) files[relative] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        files[relative] = "dir";
        walk(path);
      } else {
        const text = normalizeHookCommand(readFileSync(path).toString("latin1"), implementation).replace(HOOKS_JSON_DIGEST, "$1<hooks-sha256>$2");
        files[relative] = `file:${(stat.mode & 0o777).toString(8)}:${text}`;
      }
    }
  };
  walk(root);
  return files;
}

function runStep(implementation: "python" | "typescript", step: Step, root: string): Observation {
  const env: NodeJS.ProcessEnv = { ...withoutLocale(process.env), HOME: root, KEEL_OVERLAY_DIR: join(root, "overlay"), KEEL_DATA_DIR: join(root, "data"), ...step.env };
  delete env["CODEX_HOME"];
  Object.assign(env, step.env);
  const command = implementation === "python"
    ? ["python3", join(ADAPTER, "bin", step.command)]
    : [process.execPath, join(ADAPTER, "bin", `${step.command}.ts`)];
  const result = spawnSync(command[0] as string, [...command.slice(1), ...step.args], { env, encoding: "utf8", cwd: root });
  return {
    status: result.status,
    stdout: normalizeHookCommand(result.stdout, implementation),
    stderr: result.stderr.replace(TEMPORARY_NAME, "$1.<temporary>'").replace(SHA256_HEX, "<sha256>"),
    files: snapshot(root, implementation),
  };
}

function runScenario(implementation: "python" | "typescript", scenario: Scenario, root: string): Observation[] {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
  return scenario.steps.map((step) => {
    step.before?.(root);
    return runStep(implementation, step, root);
  });
}

function link(...args: string[]): Step {
  return { command: "link", args };
}

function config(...args: string[]): Step {
  return { command: "config", args };
}

const WRITE = link("--write");
const GOOD_CONFIG = 'model = "new"\n[features]\nhooks = true\n';

function withFiles(step: Step, files: Record<string, string | Buffer>): Step {
  return {
    ...step,
    before: (root) => {
      for (const [name, content] of Object.entries(files)) put(join(root, name), typeof content === "string" ? content.replaceAll("{root}", root) : content);
    },
  };
}

const SCENARIOS: Scenario[] = [
  { name: "dry run then write then check then unlink", steps: [link(), WRITE, link("--check"), link("--write"), link("--unlink"), link("--check")] },
  { name: "check before write reports pending actions", steps: [link("--check")] },
  { name: "unlink without install", steps: [link("--unlink")] },
  { name: "conflict with existing instructions", steps: [withFiles(WRITE, { ".codex/AGENTS.md": "owner instructions" }), link("--check")] },
  { name: "hand edited managed file", steps: [WRITE, withFiles(link("--write"), { ".codex/AGENTS.md": "owner edit" }), link("--unlink"), link("--check")] },
  {
    name: "personal overlay and custom codex home",
    steps: [{ ...withFiles(WRITE, { "overlay/PERSONAL.md": "Talk to the owner in Korean.\n", "custom codex/config.toml": 'model = "m"\n' }), env: { CODEX_HOME: "{root}/custom codex" } }],
  },
  { name: "duplicate overlay skill", steps: [withFiles(WRITE, { "overlay/skills/readable-code/SKILL.md": "duplicate" }), link("--check")] },
  { name: "extra overlay skill", steps: [withFiles(WRITE, { "overlay/skills/extra/SKILL.md": "extra" }), link("--write"), link("--unlink")] },
  { name: "existing skill link survives unlink", steps: [{ ...WRITE, before: (root) => { mkdirSync(join(root, ".agents/skills"), { recursive: true }); symlinkSync(join(ADAPTER, "..", "skills/readable-code"), join(root, ".agents/skills/readable-code")); } }, link("--unlink")] },
  { name: "conflicting existing skill directory", steps: [withFiles(WRITE, { ".agents/skills/readable-code/SKILL.md": "mine" }), link("--check")] },
  { name: "two profiles share skills", steps: [{ ...WRITE, env: { CODEX_HOME: "{root}/a" } }, { ...WRITE, env: { CODEX_HOME: "{root}/b" } }, { ...link("--unlink"), env: { CODEX_HOME: "{root}/a" } }, { ...link("--check"), env: { CODEX_HOME: "{root}/b" } }, { ...link("--unlink"), env: { CODEX_HOME: "{root}/b" } }] },
  { name: "state belongs to another skills home", steps: [WRITE, withFiles(link("--check"), { ".codex/keel-codex-state.json": '{"owned": {}, "skills_home": "/elsewhere"}' })] },
  { name: "state with invalid owned", steps: [withFiles(link("--check"), { ".codex/keel-codex-state.json": '{"owned": {"a": 1}}' })] },
  { name: "state with unexpected path", steps: [withFiles(link("--check"), { ".codex/keel-codex-state.json": '{"owned": {"/etc/passwd": "x"}, "skills_home": "{root}/.agents"}' })] },
  { name: "state not an object", steps: [withFiles(link("--check"), { ".codex/keel-codex-state.json": "[]" })] },
  { name: "state invalid json", steps: [withFiles(link("--check"), { ".codex/keel-codex-state.json": '{"owned": ' })] },
  { name: "state with bom", steps: [withFiles(link("--write"), { ".codex/keel-codex-state.json": "\ufeff{}" })] },
  { name: "state invalid utf-8", steps: [withFiles(link("--write"), { ".codex/keel-codex-state.json": Buffer.from([0x7b, 0xff, 0x7d]) })] },
  { name: "state is a directory", steps: [withFiles(link("--write"), { ".codex/keel-codex-state.json/x": "y" })] },
  { name: "registry invalid version", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 2, "skills": {}}' })] },
  { name: "registry version true", steps: [withFiles(link("--write"), { ".agents/keel-codex-skills.json": '{"version": true, "skills": {}}' })] },
  { name: "registry skills not a dict", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": []}' })] },
  { name: "registry bad entry name", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": {"a/b": {}}}' })] },
  { name: "registry bad target", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": {"a": {"target": "rel", "managed": true, "profiles": ["/p"]}}}' })] },
  { name: "registry bad managed", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": {"a": {"target": "/t", "managed": 1, "profiles": ["/p"]}}}' })] },
  { name: "registry empty profiles", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": {"a": {"target": "/t", "managed": true, "profiles": []}}}' })] },
  { name: "registry relative profile", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": {"a": {"target": "/t", "managed": true, "profiles": ["p"]}}}' })] },
  { name: "registry keeps extra fields", steps: [withFiles(WRITE, { ".agents/keel-codex-skills.json": '{"version": 1, "extra": [1, 2], "skills": {"zz": {"target": "/t", "managed": false, "profiles": ["/p"], "note": "\\u00e9"}}}' }), link("--write")] },
  { name: "registry with float version and float extras", steps: [withFiles(WRITE, { ".agents/keel-codex-skills.json": '{"version": 1.0, "ratio": 1.0, "skills": {"zz": {"target": "/t", "managed": false, "profiles": ["/p"], "weight": 100.0, "tiny": 1e-7, "huge": 1e16, "neg": -0.0}}}' }), link("--write"), link("--check")] },
  { name: "registry with float version two", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 2.0, "skills": {}}' })] },
  { name: "registry skills is a float", steps: [withFiles(link("--check"), { ".agents/keel-codex-skills.json": '{"version": 1, "skills": 1.0}' })] },
  { name: "state owned is a float", steps: [withFiles(link("--check"), { ".codex/keel-codex-state.json": '{"owned": 1.0}' })] },
  { name: "state is a float", steps: [withFiles(link("--check"), { ".codex/keel-codex-state.json": "1.0" })] },
  { name: "dry run on pre-existing owned drift", steps: [WRITE, withFiles(link("--check"), { ".codex/hooks.json": "{}" })] },
  { name: "home option variants", steps: [link("--home", "{root}/h1"), link("--home={root}/h2", "--write"), link("--ho", "{root}/h3", "--check")] },
  { name: "home with tilde and dots", steps: [link("--home", "{root}/./a//b/../c", "--check")] },
  { name: "empty home option", steps: [link("--home", "", "--check")] },
  { name: "empty home equals", steps: [link("--home=", "--check")] },
  { name: "help", steps: [link("-h"), link("--help"), link("--he"), link("-hh"), config("-h"), config("--help")] },
  { name: "help after error", steps: [link("--bogus", "-h"), link("--write", "--check", "-h"), link("--home", "-h")] },
  { name: "unknown arguments", steps: [link("--bogus"), link("x"), link("x", "--nope", "y"), link("-x"), link("-"), link("--"), link("-5"), link("a b")] },
  { name: "mutually exclusive modes", steps: [link("--write", "--check"), link("--check", "--unlink"), link("--unlink", "--write"), link("--write", "--write")] },
  { name: "abbreviations", steps: [link("--wr"), link("--w"), link("--c"), link("--u"), link("--h"), link("--he"), link("--ho", "{root}/h"), link("--che=1"), link("--home", "--h"), link("--h", "--bogus"), link("--bogus=1", "--h"), link("--he", "--h")] },
  { name: "explicit values on flags", steps: [link("--write=1"), link("--check="), link("-h=1"), link("--help=x"), link("-hx"), link("-hh"), link("-hxyz"), link("-xh")] },
  { name: "missing values", steps: [link("--home"), link("--home", "--write"), link("--home", "-x"), link("--home", "-5", "--check"), link("--home", "a b", "--check")] },
  { name: "double dash handling", steps: [link("--", "--write"), link("--write", "--"), link("--home", "--", "{root}/x"), link("--home", "{root}/x", "--", "--check"), link("x", "--", "--")] },
  { name: "config help and usage", steps: [config(), config("--profile", "x"), config("--file"), config("--file", "a", "b"), config("--fil", "x"), config("--pro=x", "--file=y")] },
  {
    name: "config updates preserving mode",
    steps: [withFiles(config("--profile", "{root}/profile", "--file", "{root}/candidate.toml"), { "profile/config.toml": "[features]\nhooks = true\n", "candidate.toml": GOOD_CONFIG })],
  },
  {
    name: "config creates a missing file",
    steps: [withFiles(config("--profile", "{root}/fresh", "--file", "{root}/candidate.toml"), { "candidate.toml": GOOD_CONFIG }), config("--profile={root}/fresh", "--file={root}/candidate.toml")],
  },
  {
    name: "config refuses policy violations",
    steps: [
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/off.toml"), { "profile/config.toml": "[features]\nhooks = true\n[hooks]\nx = 1\n", "off.toml": "[features]\nhooks = false\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/managed.toml"), { "managed.toml": "allow_managed_hooks_only = true\n[hooks]\nx = 1\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/changed.toml"), { "changed.toml": "[hooks]\nx = 2\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/scalar.toml"), { "scalar.toml": "features = 3\n[hooks]\nx = 1\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/bad.toml"), { "bad.toml": "bad [\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/same.toml"), { "same.toml": '[hooks]\nx = 1\nmodel = "m"\n' }),
    ],
  },
  {
    name: "config input failures",
    steps: [
      config("--profile", "{root}/profile", "--file", "{root}/missing.toml"),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/dir"), { "dir/x": "y" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/bytes.toml"), { "bytes.toml": Buffer.from([0x61, 0x3d, 0xff]) }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/crlf.toml"), { "crlf.toml": "[features]\r\nhooks = true\r\n" }),
      withFiles(config("--profile", "{root}/badprofile", "--file", "{root}/crlf.toml"), { "badprofile/config.toml": Buffer.from([0xff]) }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/err.toml"), { "err.toml": "a = 1\nb = 'x\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/err2.toml"), { "err2.toml": "[a]\nb = 1\n[a]\n" }),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/err3.toml"), { "err3.toml": "😀 = 1" }),
    ],
  },
  {
    name: "config file argument is normalised like pathlib",
    steps: [
      config("--profile", "{root}/profile", "--file", ""),
      config("--profile", "{root}/profile", "--file", "."),
      withFiles(config("--profile", "{root}/profile", "--file", "{root}/dir/"), { "dir/x": "y" }),
      config("--profile", "{root}/profile", "--file", "./missing.toml"),
      config("--profile", "{root}/profile", "--file", "{root}//double//slash.toml"),
      config("--profile", "{root}/profile", "--file", "a/./b/../c.toml"),
      config("--profile", "{root}/profile", "--file", "missing.toml/"),
      config("--profile", "{root}/profile", "--file", "//{root}/two-slashes.toml"),
    ],
  },
  { name: "config through env codex home", steps: [{ ...withFiles(config("--file", "{root}/c.toml"), { "c.toml": GOOD_CONFIG }), env: { CODEX_HOME: "{root}/envprofile" } }] },
  { name: "config tilde profile", steps: [withFiles(config("--profile", "~/tilde", "--file", "{root}/c.toml"), { "c.toml": GOOD_CONFIG })] },
  { name: "config relative file", steps: [withFiles(config("--profile", "{root}/p", "--file", "c.toml"), { "c.toml": GOOD_CONFIG })] },
  {
    name: "config over a read-only target",
    steps: [{ ...withFiles(config("--profile", "{root}/ro", "--file", "{root}/c.toml"), { "c.toml": GOOD_CONFIG, "ro/config.toml": "model = 'x'\n" }), before: (root) => { put(join(root, "c.toml"), GOOD_CONFIG); put(join(root, "ro/config.toml"), "model = 'x'\n"); chmodSync(join(root, "ro/config.toml"), 0o400); } }],
  },
];

function prepared(scenario: Scenario, root: string): Scenario {
  const expand = (text: string): string => text.replaceAll("{root}", root);
  return {
    name: scenario.name,
    steps: scenario.steps.map((step) => ({
      command: step.command,
      args: step.args.map(expand),
      env: step.env === undefined ? undefined : Object.fromEntries(Object.entries(step.env).map(([name, value]) => [name, expand(value)])),
      before: step.before,
    })),
  };
}

function compare(scenario: string, index: number, python: Observation, typescript: Observation): string[] {
  const found: string[] = [];
  const label = `${scenario} step ${index + 1}`;
  if (python.status !== typescript.status) found.push(`${label}: exit ${python.status} vs ${typescript.status}`);
  if (python.stdout !== typescript.stdout) found.push(`${label}: stdout\n  py: ${JSON.stringify(python.stdout)}\n  ts: ${JSON.stringify(typescript.stdout)}`);
  if (python.stderr !== typescript.stderr) found.push(`${label}: stderr\n  py: ${JSON.stringify(python.stderr)}\n  ts: ${JSON.stringify(typescript.stderr)}`);
  for (const key of new Set([...Object.keys(python.files), ...Object.keys(typescript.files)])) {
    if (python.files[key] !== typescript.files[key]) found.push(`${label}: file ${key}\n  py: ${python.files[key]?.slice(0, 200)}\n  ts: ${typescript.files[key]?.slice(0, 200)}`);
  }
  return found;
}

describe("link and config parity with the recorded Python entries", () => {
  it("writes the same stdout, stderr, exit code and files for every invocation", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-cli-parity-")));
    const mismatches: string[] = [];
    let invocations = 0;
    try {
      for (const raw of SCENARIOS) {
        const scenario = prepared(raw, root);
        const python = recordedAnswers("codex-cli-parity", [{ scenario: raw.name }], () => [runScenario("python", scenario, root)], { "{{ROOT}}": root, "{{KEEL_HOME}}": dirname(ADAPTER) })[0] as Observation[];
        const typescript = runScenario("typescript", scenario, root);
        invocations += scenario.steps.length;
        scenario.steps.forEach((_step, index) => mismatches.push(...compare(scenario.name, index, python[index] as Observation, typescript[index] as Observation)));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    console.log(`parity link/config: ${invocations} cases, ${mismatches.length} mismatches`);
    assert.ok(invocations >= 100, `${invocations} invocations`);
    assert.equal(mismatches.length, 0, mismatches.slice(0, MISMATCHES_SHOWN).join("\n"));
  });
});

describe("config crash parity on deeply nested TOML", () => {
  const SHAPES: Record<string, (depth: number) => string> = {
    arrays: (depth) => `a = ${"[".repeat(depth)}${"]".repeat(depth)}\n`,
    "inline tables": (depth) => `a = ${"{a=".repeat(depth)}1${"}".repeat(depth)}\n`,
  };

  function exitStatus(implementation: "python" | "typescript", text: string): number | null {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-config-deep-")));
    try {
      put(join(root, "candidate.toml"), text);
      const command = implementation === "python" ? ["python3", join(ADAPTER, "bin", "config")] : [process.execPath, join(ADAPTER, "bin", "config.ts")];
      const args = ["--profile", join(root, "profile"), "--file", join(root, "candidate.toml")];
      return spawnSync(command[0] as string, [...command.slice(1), ...args], { env: { ...withoutLocale(process.env), HOME: root }, encoding: "utf8" }).status;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`crashes on ${name} at the same depth as Python`, () => {
      const askPython = (): number[] => {
        let low = 1;
        let high = 700;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (exitStatus("python", shape(middle)) === 0) low = middle + 1;
          else high = middle;
        }
        assert.equal(exitStatus("python", shape(low - 1)), 0);
        assert.equal(exitStatus("python", shape(low)), 1);
        return [low];
      };
      const [low] = recordedAnswers("codex-cli-parity", [{ crashDepth: name }], () => [askPython()])[0] as [number];
      console.log(`parity config deep ${name}: python first crashes at depth ${low}`);
      assert.equal(exitStatus("typescript", shape(low - 1)), 0);
      assert.equal(exitStatus("typescript", shape(low)), 1);
    });
  }
});
