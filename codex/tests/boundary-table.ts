import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { withEnv } from "../../tests/hooks/helpers.ts";
import type { CompletedProcess } from "../../hooks/lib/hookkit/subprocess.ts";
import { main as runConfig, validateUpdate } from "../lib/config_policy.ts";
import { fingerprint, readJson } from "../lib/files.ts";
import { buildSkillLinks, main as runLink } from "../lib/install.ts";
import { planSkills } from "../lib/skill_registry.ts";
import { main as runHook, runGuard } from "../hooks/pre-tool-use.ts";
import type { GuardRunner } from "../hooks/pre-tool-use.ts";

export const LINE_BREAKS = ["\r", "\v", "\f", "\u001c", "\u001d", "\u001e", "\u0085", " ", " "];
export const UNICODE_SPACES = [
  " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
  " ", " ", "　", "﻿",
];
const JSON_WHITESPACE = [" ", "\t", "\n", "\r"];
const HAZARD_CHARACTERS = [...new Set([...LINE_BREAKS, ...UNICODE_SPACES, ...JSON_WHITESPACE])];
const DIGITS_AT_LIMIT = "1".repeat(4300);
const DIGITS_PAST_LIMIT = "1".repeat(4301);
const NUMBER_LITERALS = [
  "9007199254740991", "9007199254740992", "9007199254740993", "-9007199254740993", "12345678901234567890", "1e400", "-1e400", "1E400",
  "1e-400", "NaN", "Infinity", "-Infinity", "1.0", "-0.0", "0.0", "100.0", "1e16", DIGITS_AT_LIMIT, DIGITS_PAST_LIMIT, "-" + DIGITS_PAST_LIMIT,
  DIGITS_PAST_LIMIT + ".0", DIGITS_PAST_LIMIT + "e0",
];
const INVALID_UTF8 = {
  "start byte": [0xff], "truncated sequence": [0xe2, 0x82], "overlong slash": [0xc0, 0xaf], "encoded surrogate": [0xed, 0xa0, 0x80],
  "bad continuation": [0xc3, 0x28], "past the last code point": [0xf4, 0x90, 0x80, 0x80], "lone continuation": [0x80],
};
const SKILL_NAMES = ["a", "B", "é", "～", "\u{1f600}", "\u{10000}", ""];
const LONGEST_CHAIN = 45;
const CLI_ARGUMENTS: Record<string, string[]> = {
  "no arguments": [], "write": ["--write"], "write twice": ["--write", "--write"], "write and check": ["--write", "--check"],
  "check and unlink": ["--check", "--unlink"], "unknown option": ["--bogus"], "stray word": ["extra"], "home without value": ["--home"],
  "home empty value": ["--home", ""], "home equals": ["--home={sandbox}"], "home value": ["--home", "{sandbox}"],
  "home value that looks like an option": ["--home", "-x"], "short help": ["-h"], "long help": ["--help"],
  "help after unknown option": ["--bogus", "--help"], "help as home value": ["--home", "-h"], "abbreviated write": ["--wri"],
  "abbreviated home": ["--ho", "{sandbox}"], "double dash": ["--"], "double dash then word": ["--", "x"],
  "help then double dash": ["-h", "--"], "double dash as home value": ["--home", "--", "{sandbox}"], "double dash then option": ["--", "--write"],
  "word then two double dashes": ["x", "--", "--"], "double dash after home value": ["--home", "{sandbox}", "--", "--check"], "write equals value": ["--write=1"],
  "abbreviated help": ["--he"], "stacked short help": ["-hh"], "short help with a stray letter": ["-hx"],
  "write then double dash": ["--write", "--"], "home negative number then check": ["--home", "-5", "--check"],
  "abbreviated file": ["--fil", "x"], "abbreviated profile with equals": ["--pro=x", "--file=y"], "write check and help": ["--write", "--check", "-h"],
  "file without value": ["--file"], "file missing": ["--file", "{sandbox}/absent.toml"], "file and profile": ["--file", "{sandbox}/absent.toml", "--profile", "{sandbox}"],
  "profile only": ["--profile", "{sandbox}"], "file equals": ["--file={sandbox}/absent.toml"], "file empty": ["--file", ""],
};

export interface Probe {
  label: string;
  observe: () => string;
}

export interface Boundary {
  name: string;
  probes: Probe[];
}

function numberLabel(literal: string): string {
  return literal.replace(/1{25,}/, (run) => `1x${run.length}`);
}

export function hex(text: string): string {
  return Array.from(text, (character) => "U+" + (character.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")).join(" ");
}

interface Sandbox {
  root: string;
  profile: string;
  agents: string;
  home: string;
  repo: string;
}

function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-boundary-")));
  const sandbox = { root, profile: join(root, "profile"), agents: join(root, "agents"), home: join(root, "home"), repo: join(root, "repo") };
  for (const path of [sandbox.profile, sandbox.agents, sandbox.home, sandbox.repo, join(sandbox.agents, "skills")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(sandbox.profile, "hooks.json"), "{}\n");
  mkdirSync(join(sandbox.profile, "sessions"));
  symlinkSync(sandbox.profile, join(root, "profile-alias"));
  symlinkSync(join(sandbox.profile, "sessions"), join(root, "via-sessions"));
  symlinkSync("profile/hooks.json", join(root, "relative-link"));
  symlinkSync(join(sandbox.profile, "AGENTS.md"), join(root, "dangling-to-agents"));
  symlinkSync(Buffer.from([0x2f, 0x6e, 0x6f, 0xff]), join(root, "link-to-invalid-utf8"));
  symlinkSync("loop-b", join(root, "loop-a"));
  symlinkSync("loop-a", join(root, "loop-b"));
  for (let hop = 0; hop < LONGEST_CHAIN; hop += 1) symlinkSync(hop === LONGEST_CHAIN - 1 ? join(sandbox.profile, "hooks.json") : `chain-${hop + 1}`, join(root, `chain-${hop}`));
  return sandbox;
}

function environmentOf(sandbox: Sandbox): Record<string, string | null> {
  return {
    HOME: sandbox.home, KEEL_CODEX_HOME: sandbox.profile, KEEL_AGENTS_HOME: sandbox.agents, KEEL_DATA_DIR: join(sandbox.root, "data"),
    KEEL_OVERLAY_DIR: join(sandbox.root, "overlay"), CODEX_HOME: null, PYTHONUTF8: null, PYTHONIOENCODING: null, PYTHONCOERCECLOCALE: null,
    LANG: null, LC_ALL: null, LC_CTYPE: null,
  };
}

function hookObservation(sandbox: Sandbox, stdin: string | Buffer): string {
  const guardInputs: string[] = [];
  const runner: GuardRunner = (_command, input): CompletedProcess => {
    guardInputs.push(input);
    return { returncode: 0, stdout: "", stderr: "" };
  };
  const bytes = typeof stdin === "string" ? Buffer.from(stdin, "utf8") : stdin;
  let result;
  try {
    result = withEnv(environmentOf(sandbox), () => runHook(() => bytes, runner));
  } catch {
    return "crash";
  }
  if (result.code !== 0) return `exit ${result.code}`;
  if (result.stdout === "") return `pass, guard calls ${guardInputs.length}`;
  const decision = (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision?: string } }).hookSpecificOutput;
  return decision.permissionDecision === "deny" ? "deny" : "context";
}

function patchedFiles(sandbox: Sandbox, patch: string): string {
  const calls: Array<[string, string]> = [];
  const runner: GuardRunner = (_command, input): CompletedProcess => {
    const { tool_input: tool } = JSON.parse(input) as { tool_input: { file_path: string; content: string } };
    calls.push([tool.file_path, tool.content]);
    return { returncode: 0, stdout: "", stderr: "" };
  };
  const stdin = JSON.stringify({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: sandbox.repo });
  let result;
  try {
    result = withEnv(environmentOf(sandbox), () => runHook(() => Buffer.from(stdin), runner));
  } catch {
    return "crash";
  }
  if (result.stdout !== "") return "deny";
  return JSON.stringify(calls);
}

function bashPayload(sandbox: Sandbox, command: string, extra = ""): string {
  return `{"tool_name": "Bash", "tool_input": {"command": ${JSON.stringify(command)}}, "cwd": ${JSON.stringify(sandbox.repo)}${extra}}`;
}

function outcomeOf(body: () => unknown): string {
  try {
    body();
    return "accepted";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.name === "RecursionError" ? "crash" : "refused";
  }
}

function guardFailure(stdout: string, stderr: string, returncode: number): string {
  const runner: GuardRunner = () => ({ returncode, stdout, stderr });
  try {
    return `ok ${JSON.stringify(runGuard("git-guard", { tool_name: "Bash" }, runner))}`;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message.startsWith("invalid JSON: ") ? "refused invalid JSON" : `refused ${error.message}`;
  }
}

function hookStdinProbes(sandbox: Sandbox): Probe[] {
  const payload = bashPayload(sandbox, "echo hi");
  const probes: Probe[] = [];
  const add = (label: string, stdin: string | Buffer): number => probes.push({ label, observe: () => hookObservation(sandbox, stdin) });
  add("empty stdin", "");
  add("one newline", "\n");
  add("payload then one newline", payload + "\n");
  add("payload then two newlines", payload + "\n\n");
  for (const character of HAZARD_CHARACTERS) {
    add(`${hex(character)} before the payload`, character + payload);
    add(`${hex(character)} after the payload`, payload + character);
    add(`${hex(character)} between the opening brace and the first key`, payload.replace("{", "{" + character));
    add(`${hex(character)} inside the command string`, bashPayload(sandbox, `echo a${character}b`));
    add(`${hex(character)} alone`, character);
  }
  return probes;
}

function hookNumberProbes(sandbox: Sandbox): Probe[] {
  const probes: Probe[] = [];
  for (const literal of NUMBER_LITERALS) {
    const label = numberLabel(literal);
    probes.push({ label: `extra field ${label}`, observe: () => hookObservation(sandbox, bashPayload(sandbox, "echo hi", `, "extra": ${literal}`)) });
    probes.push({ label: `extra field ${label} beside a force push`, observe: () => hookObservation(sandbox, bashPayload(sandbox, "git push --force origin main", `, "extra": ${literal}`)) });
    probes.push({ label: `cwd ${label}`, observe: () => hookObservation(sandbox, `{"tool_name": "Bash", "tool_input": {"command": "echo hi"}, "cwd": ${literal}}`) });
    probes.push({ label: `list of ${label}`, observe: () => hookObservation(sandbox, bashPayload(sandbox, "echo hi", `, "extra": [${literal}, {"k": ${literal}}]`)) });
  }
  return probes;
}

function hookByteProbes(sandbox: Sandbox): Probe[] {
  const head = Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo ');
  const tail = Buffer.from(`"}, "cwd": ${JSON.stringify(sandbox.repo)}}`);
  const probes: Probe[] = Object.entries(INVALID_UTF8).map(([label, bytes]) => ({
    label: `invalid UTF-8 ${label} in a command`, observe: () => hookObservation(sandbox, Buffer.concat([head, Buffer.from(bytes), tail])),
  }));
  probes.push({ label: "invalid UTF-8 before a protected write", observe: () => hookObservation(sandbox, Buffer.concat([
    Buffer.from(`{"tool_name": "Write", "tool_input": {"file_path": ${JSON.stringify(join(sandbox.profile, "hooks.json"))}, "content": "`), Buffer.from([0xc3, 0x28]), tail])) });
  probes.push({ label: "byte order mark before the payload", observe: () => hookObservation(sandbox, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), head, tail])) });
  probes.push({ label: "byte order mark inside a command", observe: () => hookObservation(sandbox, Buffer.concat([head, Buffer.from([0xef, 0xbb, 0xbf]), tail])) });
  probes.push({ label: "valid non-ASCII command", observe: () => hookObservation(sandbox, Buffer.concat([head, Buffer.from("héllo \u{1f600}"), tail])) });
  return probes;
}

function patchProbes(sandbox: Sandbox): Probe[] {
  const protectedPath = join(sandbox.profile, "hooks.json");
  const probes: Probe[] = [];
  const add = (label: string, patch: string): number => probes.push({ label, observe: () => patchedFiles(sandbox, patch) });
  for (const character of LINE_BREAKS) {
    add(`${hex(character)} before a header that names a protected file`, `*** Add File: ok.txt\n+x${character}*** Add File: ${protectedPath}\n+y`);
    add(`${hex(character)} inside a path`, `*** Add File: a${character}b.txt\n+x`);
    add(`${hex(character)} inside an added line`, `*** Add File: a.txt\n+one${character}two\n+three`);
    add(`${hex(character)} ending the patch`, `*** Add File: a.txt\n+x${character}`);
  }
  add("one trailing newline", "*** Add File: a.txt\n+x\n");
  add("two trailing newlines", "*** Add File: a.txt\n+x\n\n");
  add("empty lines between files", "*** Add File: a.txt\n+x\n\n\n*** Add File: b.txt\n+y");
  add("carriage return and line feed", "*** Add File: a.txt\r\n+x\r\n+y\r\n");
  add("bare carriage returns", "*** Add File: a.txt\r+x\r+y");
  add("empty patch", "");
  add("only a newline", "\n");
  add("added empty lines", "*** Add File: a.txt\n+\n+\n++");
  return probes;
}

function writeProbes(sandbox: Sandbox): Probe[] {
  const { root, profile } = sandbox;
  const targets: Record<string, string> = {
    "protected file": `${profile}/hooks.json`,
    "dot segment": `${profile}/./hooks.json`,
    "double slash": `${profile}//hooks.json`,
    "dotdot through a real directory": `${profile}/sessions/../hooks.json`,
    "dotdot after a missing directory": `${profile}/missing/../hooks.json`,
    "dotdot through a symlinked directory": `${root}/via-sessions/../hooks.json`,
    "dotdot through a symlinked directory to a plain file": `${root}/via-sessions/../notes.txt`,
    "relative symlink to the file": `${root}/relative-link`,
    "dangling symlink to a protected name": `${root}/dangling-to-agents`,
    "symlink loop": `${root}/loop-a`,
    "symlink whose target is not valid UTF-8": `${root}/link-to-invalid-utf8`,
    "name below a symlink whose target is not valid UTF-8": `${root}/link-to-invalid-utf8/x.txt`,
    "chain of one hop": `${root}/chain-${LONGEST_CHAIN - 1}`,
    "chain of 39 hops": `${root}/chain-${LONGEST_CHAIN - 39}`,
    "chain of 40 hops": `${root}/chain-${LONGEST_CHAIN - 40}`,
    "chain of 41 hops": `${root}/chain-${LONGEST_CHAIN - 41}`,
    "chain of 45 hops": `${root}/chain-0`,
    "relative path from the working directory": "../profile/hooks.json",
    "profile directory": profile,
    "sessions directory": `${profile}/sessions`,
    "empty path": "",
    "NUL character": `${profile}/a\u0000b`,
    "NUL character in a plain file name": `${root}/a\u0000b`,
    "unpaired high surrogate": `${root}/\ud800`,
    "unpaired low surrogate": `${root}/\udfff`,
    "surrogate escape byte": `${root}/\udc80`,
    "surrogate escape byte between letters": `${root}/x\udc80y`,
    "surrogate in a parent directory": `${profile}/\ud800/hooks.json`,
    "surrogate pair": `${root}/\u{1f600}`,
    "non-BMP name next to a private-use name": `${root}/\ue000\u{10000}`,
  };
  return Object.entries(targets).map(([label, filePath]) => ({
    label: `write to ${label}`,
    observe: () => hookObservation(sandbox, JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath, content: "x" }, cwd: sandbox.repo })),
  }));
}

function guardOutputProbes(): Probe[] {
  const probes: Probe[] = [];
  for (const character of [...UNICODE_SPACES, ...LINE_BREAKS, " ", "\t", "\n", "\u001f", "\u0000"]) {
    probes.push({ label: `stderr of only ${hex(character)}`, observe: () => guardFailure("", character, 2) });
    probes.push({ label: `stderr of ${hex(character)} around a reason`, observe: () => guardFailure("", `${character}blocked${character}`, 2) });
    probes.push({ label: `stdout of only ${hex(character)}`, observe: () => guardFailure(character, "", 0) });
  }
  return probes;
}

function tomlProbes(): Probe[] {
  const current = "[features]\nhooks = true\n";
  const probes: Probe[] = [];
  for (const character of HAZARD_CHARACTERS) {
    probes.push({ label: `${hex(character)} in a comment`, observe: () => outcomeOf(() => validateUpdate(current, `# a${character}b\n[features]\nhooks = true\n`)) });
    probes.push({ label: `${hex(character)} in a basic string`, observe: () => outcomeOf(() => validateUpdate(current, `a = "x${character}y"\n[features]\nhooks = true\n`)) });
    probes.push({ label: `${hex(character)} in a literal string`, observe: () => outcomeOf(() => validateUpdate(current, `a = 'x${character}y'\n[features]\nhooks = true\n`)) });
    probes.push({ label: `${hex(character)} between a key and its equals sign`, observe: () => outcomeOf(() => validateUpdate(current, `a${character}= 1\n[features]\nhooks = true\n`)) });
    probes.push({ label: `${hex(character)} after the last line`, observe: () => outcomeOf(() => validateUpdate(current, `[features]\nhooks = true\n${character}`)) });
  }
  for (const literal of ["9007199254740993", "1e400", "nan", "inf", DIGITS_AT_LIMIT, DIGITS_PAST_LIMIT]) {
    probes.push({ label: `number ${numberLabel(literal)}`, observe: () => outcomeOf(() => validateUpdate(current, `x = ${literal}\n[features]\nhooks = true\n`)) });
  }
  return probes;
}

function stateFileProbes(sandbox: Sandbox): Probe[] {
  const probes: Probe[] = [];
  let index = 0;
  const add = (label: string, content: string | Buffer): number => probes.push({
    label,
    observe: () => {
      index += 1;
      const path = join(sandbox.root, `state-${index}.json`);
      writeFileSync(path, content);
      return outcomeOf(() => readJson(path));
    },
  });
  add("empty file", "");
  add("empty object", "{}");
  add("object then newline", "{}\n");
  add("object then two newlines", "{}\n\n");
  add("array", "[]");
  add("null", "null");
  for (const literal of NUMBER_LITERALS) add(`member ${numberLabel(literal)}`, `{"n": ${literal}}`);
  for (const character of HAZARD_CHARACTERS) {
    add(`${hex(character)} before the object`, character + "{}");
    add(`${hex(character)} between the brace and the key`, `{${character}"a": 1}`);
    add(`${hex(character)} inside a string`, `{"a": "x${character}y"}`);
  }
  for (const [label, bytes] of Object.entries(INVALID_UTF8)) add(`invalid UTF-8 ${label}`, Buffer.concat([Buffer.from('{"a": "'), Buffer.from(bytes), Buffer.from('"}')]));
  add("byte order mark first", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
  add("duplicate keys", '{"a": 1, "a": 2}');
  add("lone surrogate escape", '{"a": "\\ud800"}');
  add("escaped line separator", '{"a": "\\u2028"}');
  return probes;
}

function textFileProbes(sandbox: Sandbox): Probe[] {
  const probes: Probe[] = [];
  let index = 0;
  const add = (label: string, content: string | Buffer): number => probes.push({
    label,
    observe: () => {
      index += 1;
      const path = join(sandbox.root, `text-${index}.md`);
      writeFileSync(path, content);
      try {
        return `digest ${fingerprint(path)}`;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return "refused";
      }
    },
  });
  add("empty file", "");
  add("carriage return and line feed", "a\r\nb\r\n");
  add("bare carriage return", "a\rb\r");
  add("carriage returns in a row", "a\r\r\nb\r\n\r\n");
  add("byte order mark kept", "﻿a\n");
  add("trailing newline kept once", "a\n");
  for (const character of [...LINE_BREAKS.filter((item) => item !== "\r"), ...UNICODE_SPACES]) add(`${hex(character)} inside a line`, `a${character}b\n`);
  for (const [label, bytes] of Object.entries(INVALID_UTF8)) add(`invalid UTF-8 ${label}`, Buffer.concat([Buffer.from("a"), Buffer.from(bytes), Buffer.from("b")]));
  return probes;
}

function sortOrderProbes(sandbox: Sandbox): Probe[] {
  const skills = join(sandbox.root, "source", "skills");
  mkdirSync(skills, { recursive: true });
  for (const name of SKILL_NAMES) {
    mkdirSync(join(skills, name));
    writeFileSync(join(skills, name, "SKILL.md"), "x");
  }
  const profiles = ["/p/\u{1f600}", "/p/～", "/p/a", "/p/é", "/p/\u{10000}"];
  return [
    {
      label: "skill directories in code point order",
      observe: () => JSON.stringify(Array.from(buildSkillLinks(sandbox.home, join(sandbox.root, "no-overlay"), join(sandbox.root, "source")).keys(), (path) => basename(path))),
    },
    {
      label: "profile references in code point order",
      observe: () => {
        const desired = new Map([[join(sandbox.agents, "skills", "demo"), { kind: "link" as const, content: "/target" }]]);
        const registry = JSON.stringify({ version: 1, skills: { demo: { target: "/target", managed: true, profiles: profiles.slice().reverse().concat("/p/b") } } });
        writeFileSync(join(sandbox.agents, "keel-codex-skills.json"), registry);
        return JSON.stringify(planSkills(sandbox.agents, "/p/z", desired).records.get("demo")?.profiles);
      },
    },
  ];
}

function commandLineProbes(sandbox: Sandbox): Probe[] {
  return Object.entries(CLI_ARGUMENTS).flatMap(([label, template]) => {
    const argv = template.map((argument) => argument.replaceAll("{sandbox}", sandbox.root));
    const observe = (run: (argv: readonly string[]) => { code: number }) => () => {
      rmSync(join(sandbox.root, "dry"), { recursive: true, force: true });
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      try {
        return `exit ${withEnv(environmentOf(sandbox), () => run(argv).code)}`;
      } catch {
        return "crash";
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
      }
    };
    return [
      { label: `link ${label}`, observe: observe((args) => runLink(args.includes("--write") || args.includes("--check") || args.includes("--unlink") ? ["--home", join(sandbox.root, "dry"), ...args] : args)) },
      { label: `config ${label}`, observe: observe(runConfig) },
    ];
  });
}

export function boundaries(): { boundaries: Boundary[]; close: () => void } {
  const sandbox = makeSandbox();
  const list: Boundary[] = [
    { name: "hook stdin", probes: hookStdinProbes(sandbox) },
    { name: "hook numbers", probes: hookNumberProbes(sandbox) },
    { name: "hook bytes", probes: hookByteProbes(sandbox) },
    { name: "apply_patch lines", probes: patchProbes(sandbox) },
    { name: "write targets", probes: writeProbes(sandbox) },
    { name: "guard output", probes: guardOutputProbes() },
    { name: "TOML", probes: tomlProbes() },
    { name: "state file", probes: stateFileProbes(sandbox) },
    { name: "text file", probes: textFileProbes(sandbox) },
    { name: "sort order", probes: sortOrderProbes(sandbox) },
    { name: "command line", probes: commandLineProbes(sandbox) },
  ];
  return { boundaries: list, close: () => rmSync(sandbox.root, { recursive: true, force: true }) };
}
