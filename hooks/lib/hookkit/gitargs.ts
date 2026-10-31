import { basename } from "./paths.ts";
import { codePointLength, lstripChar, partition } from "./text.ts";
import { resolveDirectory } from "./variables.ts";
import type { Variables } from "./variables.ts";

const DASHED_GIT_PROGRAM_RE = /^git-([a-z0-9][a-z0-9-]*)$/;
export const GIT_VALUE_OPTIONS: ReadonlySet<string> =
  new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--push-option", "--receive-pack", "--exec"]);
const PUSH_OPTION_LETTER = "o";
const PUSH_REPO_OPTION = "--repo";
const WHOLE_REPO_PUSH_OPTIONS: ReadonlySet<string> = new Set(["--all", "--branches", "--mirror"]);
export const GH_REPO_OPTIONS: ReadonlySet<string> = new Set(["-R", "--repo"]);
const GH_SUBCOMMAND_DEPTH = 2;
const CONFIG_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["get", "list"]);
const CONFIG_READ_OPTIONS: ReadonlySet<string> = new Set([
  "-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool",
]);
const CONFIG_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(["set", "unset", "rename-section", "remove-section", "edit"]);
const CONFIG_WRITE_OPTIONS: ReadonlySet<string> = new Set([
  "--unset", "--unset-all", "--remove-section", "--rename-section", "--add", "--replace-all", "-e", "--edit",
]);
const CONFIG_VALUE_OPTIONS: ReadonlySet<string> =
  new Set(["-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--value"]);

export class PushArguments {
  remote: string | null = null;
  refspecs: string[] = [];
  longOptions: string[] = [];
  shortFlags = "";

  get wholeRepo(): boolean {
    return this.longOptions.some((option) => WHOLE_REPO_PUSH_OPTIONS.has(option));
  }
}

export function gitDirectory(argv: readonly string[], directory: string, environment: Variables): string {
  const words = argv.slice(1, gitSubcommandIndex(argv) ?? undefined).values();
  for (const word of words) {
    if (word === "-C") directory = resolveDirectory(directory, nextWord(words) ?? ".", environment);
  }
  return directory;
}

export function ghSubcommandArgv(argv: readonly string[]): string[] {
  let head = argv.slice(0, 1);
  let moved: string[] = [];
  let rest = argv.slice(1);
  while (rest.length > 0 && head.length <= GH_SUBCOMMAND_DEPTH) {
    const first = rest[0] ?? "";
    if (GH_REPO_OPTIONS.has(first)) {
      moved = [...moved, ...rest.slice(0, 2)];
      rest = rest.slice(2);
    } else if (attachedGhRepo(first) !== null) {
      moved = [...moved, ...rest.slice(0, 1)];
      rest = rest.slice(1);
    } else {
      head = [...head, ...rest.slice(0, 1)];
      rest = rest.slice(1);
    }
  }
  return [...head, ...rest, ...moved];
}

export function attachedGhRepo(word: string): string | null {
  if (word.startsWith("--repo=")) return partition(word, "=")[2];
  if (word.startsWith("-R") && codePointLength(word) > 2) {
    const value = word.slice(2);
    return value.startsWith("=") ? value.slice(1) : value;
  }
  return null;
}

export function readPushArguments(args: readonly string[]): PushArguments {
  const pushed = new PushArguments();
  const positional: string[] = [];
  let repoOption: string | null = null;
  const words = args.values();
  for (const word of words) {
    if (word === PUSH_REPO_OPTION) {
      repoOption = nextWord(words);
    } else if (word.startsWith(PUSH_REPO_OPTION + "=")) {
      repoOption = partition(word, "=")[2];
    } else if (PUSH_VALUE_OPTIONS.has(word)) {
      nextWord(words);
    } else if (word === "--") {
      positional.push(...words);
    } else if (word.startsWith("--")) {
      pushed.longOptions.push(word);
    } else if (word.startsWith("-")) {
      const [flags, takesValue, attachedValue] = partition(word.slice(1), PUSH_OPTION_LETTER);
      pushed.shortFlags += flags;
      if (takesValue && !attachedValue) nextWord(words);
    } else {
      positional.push(word);
    }
  }
  if (positional.length > 0) {
    pushed.remote = positional[0] ?? null;
    pushed.refspecs = positional.slice(1);
  } else {
    pushed.remote = repoOption;
    pushed.refspecs = [];
  }
  return pushed;
}

export interface PushedRefspec {
  source: string;
  destination: string | null;
  forced: boolean;
  deletesDestination: boolean;
}

export interface PushInterpretation {
  options: PushArguments;
  refspecs: PushedRefspec[];
  deletes: boolean;
}

export function interpretPush(args: readonly string[]): PushInterpretation {
  const options = readPushArguments(args);
  const refspecs = options.refspecs.map((word): PushedRefspec => {
    const spec = lstripChar(word, "+");
    const [source, , destination] = partition(spec, ":");
    return { source, destination: destination || null, forced: word.startsWith("+"), deletesDestination: spec.startsWith(":") };
  });
  const deletes = options.longOptions.includes("--delete") || options.shortFlags.includes("d");
  return { options, refspecs, deletes };
}

export function isConfigRead(args: readonly string[]): boolean {
  const subcommand = args[0];
  if ((subcommand !== undefined && CONFIG_READ_SUBCOMMANDS.has(subcommand)) || args.some((arg) => CONFIG_READ_OPTIONS.has(arg))) {
    return true;
  }
  const writes = (subcommand !== undefined && CONFIG_WRITE_SUBCOMMANDS.has(subcommand)) ||
    args.some((arg) => CONFIG_WRITE_OPTIONS.has(arg));
  return !writes && configOperands(args).length <= 1;
}

export function configKey(args: readonly string[]): string | null {
  const first = args[0];
  const leadingSubcommand = first !== undefined && (CONFIG_READ_SUBCOMMANDS.has(first) || CONFIG_WRITE_SUBCOMMANDS.has(first));
  return configOperands(leadingSubcommand ? args.slice(1) : args)[0] ?? null;
}

function configOperands(args: readonly string[]): string[] {
  const operands: string[] = [];
  const words = args.values();
  for (const word of words) {
    if (CONFIG_VALUE_OPTIONS.has(word)) nextWord(words);
    else if (!word.startsWith("-")) operands.push(word);
  }
  return operands;
}

export function nextWord(words: IteratorObject<string>): string | null {
  const next = words.next();
  return next.done ? null : next.value;
}

export function gitSubcommandIndex(argv: readonly string[]): number | null {
  if (argv.length === 0 || basename(argv[0] ?? "") !== "git") return null;
  let index = 1;
  while (index < argv.length) {
    const word = argv[index] ?? "";
    if (GIT_VALUE_OPTIONS.has(word)) index += 2;
    else if (word.startsWith("-")) index += 1;
    else return index;
  }
  return null;
}

export function dashedGitSubcommand(word: string): string | null {
  return DASHED_GIT_PROGRAM_RE.exec(basename(word))?.[1] ?? null;
}

export function gitSubcommand(argv: readonly string[]): string | null {
  const index = gitSubcommandIndex(argv);
  return index === null ? null : (argv[index] ?? null);
}
