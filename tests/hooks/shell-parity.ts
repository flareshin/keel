/**
 * Parity evidence for the shell parser port: one corpus of command strings goes through every public function of
 * hookkit/shell.py (via shell_parity_py.py) and hookkit/shell.ts; the JSON-normalized results must be equal.
 * Run: node tests/hooks/shell-parity.ts
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import * as shell from "../../hooks/lib/hookkit/shell.ts";
import { sortedByCodePoint } from "../../hooks/lib/hookkit/pycompat.ts";
import { ADVERSARIAL_SPELLINGS } from "./shell-parity-corpus.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const COMPANION = join(import.meta.dirname, "shell_parity_py.py");
const PUSH_MERGE_SPELLINGS = join(ROOT, "tests", "fixtures", "push-merge-spellings.tsv");
const CWD = "/work";
const EXEMPT_PREFIXES = ["/tmp/", "/work/"];
const ENVIRONMENTS: Array<Array<[string, string]>> = [[], [["A", "/a"], ["APP", "/x/app"]]];
const FIXTURE_PLACEHOLDERS: Array<[string, string]> = [["{repo}", "/work/repo"], ["{tmp}", "/tmp/outside"], ["{head}", "0123456789abcdef"]];
const MAX_MISMATCHES_SHOWN = 10;

interface Call {
  fn: string;
  args: unknown[];
}

export interface ParityReport {
  corpusSize: number;
  cases: number;
  mismatches: number;
  details: string[];
}

type Json = unknown;

function mapPairs(map: Map<string, string>): Json {
  return Array.from(map.entries()).map(([key, value]) => [key, value]);
}

function commandView(command: shell.SimpleCommand, indexOf: Map<shell.SimpleCommand, number>): Json {
  return {
    argv: command.argv, assignments: command.assignments.map((item) => [...item]),
    redirects: command.redirects.map((redirect) => [redirect.op, redirect.target]), heredocs: command.heredocs,
    nested: command.nested, pipes_to_next: command.pipesToNext,
    parent: command.parent === null ? null : (indexOf.get(command.parent) ?? -1),
  };
}

function indexes(commands: shell.SimpleCommand[]): Map<shell.SimpleCommand, number> {
  return new Map(commands.map((command, index) => [command, index]));
}

function invocationView(invocation: shell.Invocation): Json {
  return {
    argv: invocation.argv, assignments: invocation.assignments.map((item) => [...item]), clears_env: invocation.clearsEnv,
    removed_names: sortedByCodePoint(invocation.removedNames), unattributable_options: invocation.unattributableOptions,
    moves_directory: invocation.movesDirectory,
  };
}

function targetsView(targets: shell.WriteTargets): Json {
  return { written: targets.written, removed: targets.removed, sources: targets.sources, unknown: targets.unknown, any: targets.any() };
}

function pushView(pushed: shell.PushArguments): Json {
  return {
    remote: pushed.remote, refspecs: pushed.refspecs, long_options: pushed.longOptions, short_flags: pushed.shortFlags,
    whole_repo: pushed.wholeRepo,
  };
}

function variables(pairs: Array<[string, string]>): Map<string, string> {
  return new Map(pairs);
}

const TYPESCRIPT_TABLE: Record<string, (...args: never[]) => Json> = {
  parse_commands: (text: string) => {
    const commands = shell.parseCommands(text);
    const indexOf = indexes(commands);
    return commands.map((command) => commandView(command, indexOf));
  },
  steps: (text: string, cwd: string) => {
    const found = shell.steps(text, cwd);
    const indexOf = indexes(found.map((step) => step.command));
    return found.map((step) => ({
      argv: step.argv, environment: mapPairs(step.environment), directory: step.directory,
      command: commandView(step.command, indexOf), expansion: mapPairs(step.expansion),
      unattributable_options: step.unattributableOptions,
    }));
  },
  unwrap_each: (text: string) => shell.parseCommands(text).map((command) => invocationView(shell.unwrap(command))),
  write_targets_each: (text: string) => shell.parseCommands(text).map((command) => targetsView(shell.writeTargets(command))),
  command_writes_files: (text: string, exceptUnder: string[]) => shell.commandWritesFiles(text, exceptUnder),
  git_subcommand_index: (argv: string[]) => shell.gitSubcommandIndex(argv),
  git_directory: (argv: string[], directory: string, pairs: Array<[string, string]>) =>
    shell.gitDirectory(argv, directory, variables(pairs)),
  gh_subcommand_argv: (argv: string[]) => shell.ghSubcommandArgv(argv),
  attached_gh_repo: (word: string) => shell.attachedGhRepo(word),
  read_push_arguments: (args: string[]) => pushView(shell.readPushArguments(args)),
  is_config_read: (args: string[]) => shell.isConfigRead(args),
  config_key: (args: string[]) => shell.configKey(args),
  dashed_git_subcommand: (word: string) => shell.dashedGitSubcommand(word),
  resolve_directory: (directory: string, target: string, pairs: Array<[string, string]>) =>
    shell.resolveDirectory(directory, target, variables(pairs)),
};

function runTypeScript(calls: Call[]): Json[] {
  return calls.map((call) => {
    try {
      const handler = TYPESCRIPT_TABLE[call.fn];
      if (handler === undefined) throw new Error(`unknown function ${call.fn}`);
      return (handler as (...args: unknown[]) => Json)(...call.args);
    } catch {
      return { error: true };
    }
  });
}

function runCompanion(mode: string, input: string, files: string[] = []): Json {
  const result = spawnSync("python3", ["-I", COMPANION, join(ROOT, "hooks", "lib"), mode, ...files], {
    input, encoding: "utf8", maxBuffer: 1 << 30,
  });
  if (result.status !== 0) throw new Error(`companion failed: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout) as Json;
}

function pythonFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory)).filter((name) => name.endsWith(".py")).sort().map((name) => join(ROOT, directory, name));
}

function fixtureCommands(): string[] {
  const rows = readFileSync(PUSH_MERGE_SPELLINGS, "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("#"));
  const commands: string[] = [];
  for (const line of rows.slice(1)) {
    let command = line.split("\t")[0] ?? "";
    for (const [placeholder, value] of FIXTURE_PLACEHOLDERS) command = command.replaceAll(placeholder, value);
    commands.push(command.replaceAll("\\n", "\n"));
  }
  return commands;
}

export function buildCorpus(): string[] {
  const literals = runCompanion("corpus", "", [...pythonFiles("tests/hooks"), ...pythonFiles("tests/ship-gate")]) as string[];
  return sortedByCodePoint(new Set([...literals, ...fixtureCommands(), ...ADVERSARIAL_SPELLINGS]));
}

function textCalls(corpus: string[]): Call[] {
  return corpus.flatMap((text) => [
    { fn: "parse_commands", args: [text] },
    { fn: "steps", args: [text, CWD] },
    { fn: "unwrap_each", args: [text] },
    { fn: "write_targets_each", args: [text] },
    { fn: "command_writes_files", args: [text, []] },
    { fn: "command_writes_files", args: [text, EXEMPT_PREFIXES] },
  ]);
}

function argvCalls(corpus: string[]): Call[] {
  const argvs = new Map<string, string[]>();
  for (const text of corpus) {
    for (const command of shell.parseCommands(text)) {
      for (const argv of [command.argv, shell.unwrap(command).argv]) argvs.set(JSON.stringify(argv), argv);
    }
  }
  const words = new Set<string>();
  const calls: Call[] = [];
  for (const argv of argvs.values()) {
    for (const word of argv) words.add(word);
    calls.push(
      { fn: "git_subcommand_index", args: [argv] },
      { fn: "gh_subcommand_argv", args: [argv] },
      { fn: "read_push_arguments", args: [argv.slice(1)] },
      { fn: "read_push_arguments", args: [argv.slice(2)] },
      { fn: "is_config_read", args: [argv.slice(1)] },
      { fn: "is_config_read", args: [argv.slice(2)] },
      { fn: "config_key", args: [argv.slice(1)] },
      { fn: "config_key", args: [argv.slice(2)] },
      ...ENVIRONMENTS.map((environment) => ({ fn: "git_directory", args: [argv, CWD, environment] })),
    );
  }
  for (const word of words) {
    calls.push({ fn: "attached_gh_repo", args: [word] }, { fn: "dashed_git_subcommand", args: [word] });
    for (const environment of ENVIRONMENTS) calls.push({ fn: "resolve_directory", args: [CWD, word, environment] });
  }
  return calls;
}

export function runParity(): ParityReport {
  const corpus = buildCorpus();
  const calls = [...textCalls(corpus), ...argvCalls(corpus)];
  const expected = runCompanion("run", JSON.stringify(calls)) as Json[];
  const actual = runTypeScript(calls);
  const details: string[] = [];
  let mismatches = 0;
  calls.forEach((call, index) => {
    if (isDeepStrictEqual(JSON.parse(JSON.stringify(actual[index])), expected[index])) return;
    mismatches += 1;
    if (details.length < MAX_MISMATCHES_SHOWN) {
      details.push(`${call.fn}(${JSON.stringify(call.args)})\n  python:     ${JSON.stringify(expected[index])}\n  typescript: ${JSON.stringify(actual[index])}`);
    }
  });
  return { corpusSize: corpus.length, cases: calls.length, mismatches, details };
}

if (import.meta.main) {
  const report = runParity();
  for (const detail of report.details) console.error(detail);
  console.log(`parity: ${report.cases} cases, ${report.mismatches} mismatches`);
  process.exit(report.mismatches === 0 ? 0 : 1);
}
