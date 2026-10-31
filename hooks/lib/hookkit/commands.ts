import { basename } from "./paths.ts";
import { arraysEqual, codePointLength, partition } from "./text.ts";
import { dashedGitSubcommand } from "./gitargs.ts";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RUN_TIME_WORD_RE = /[$`]/;
const TIME_FLAGS: ReadonlySet<string> = new Set(["-p"]);
const COMMAND_FLAGS: ReadonlySet<string> = new Set(["-p"]);
const EXEC_FLAGS: ReadonlySet<string> = new Set(["-c", "-l"]);
const EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-a"]);
const NICE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-n", "--adjustment"]);
const TIMEOUT_FLAGS: ReadonlySet<string> = new Set(["--preserve-status", "--foreground", "-v", "--verbose"]);
const TIMEOUT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-k", "-s", "--kill-after", "--signal"]);
const SUDO_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set(["-D", "--chdir", "-R", "--chroot"]);
const SUDO_MOVING_OPTIONS: ReadonlySet<string> = new Set([...SUDO_DIRECTORY_OPTIONS, "-i", "--login"]);
const ENV_UNSET_OPTION = "-u";
const ENV_MOVING_OPTIONS: ReadonlySet<string> = new Set(["-C", "--chdir", "-S", "--split-string"]);
const ENV_VALUE_OPTIONS: ReadonlySet<string> = new Set([ENV_UNSET_OPTION, "-P"]);
const SUDO_FLAGS: ReadonlySet<string> = new Set([
  "-A", "-b", "-E", "-H", "-k", "-n", "-P", "-S", "-s", "--askpass", "--background", "--preserve-env", "--set-home",
  "--reset-timestamp", "--non-interactive", "--preserve-groups", "--stdin", "--shell",
]);
const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C", "-g", "-h", "-p", "-r", "-T", "-t", "-U", "-u", "--close-from", "--group", "--host", "--prompt", "--role",
  "--command-timeout", "--type", "--other-user", "--user",
]);
const EXEC_NICE_ADJUSTMENT_RE = /^--?\p{Nd}+$/u;
const NO_OPTIONS: ReadonlySet<string> = new Set();

export type Assignment = readonly [name: string, value: string];

export interface Redirect {
  op: string;
  target: string;
  fd?: string;
}

export function commandName(argv: readonly string[]): string {
  return argv.length > 0 ? basename(argv[0] ?? "") : "";
}

export class SimpleCommand {
  argv: string[] = [];
  assignments: Assignment[] = [];
  redirects: Redirect[] = [];
  heredocs: string[] = [];
  nested: boolean;
  pipesToNext = false;
  parent: SimpleCommand | null;

  constructor(nested: boolean = false, parent: SimpleCommand | null = null) {
    this.nested = nested;
    this.parent = parent;
  }

  get name(): string {
    return commandName(this.argv);
  }
}

export class Invocation {
  argv: string[];
  assignments: Assignment[];
  clearsEnv = false;
  removedNames: Set<string> = new Set();
  unattributableOptions: string[] = [];
  movesDirectory = false;

  constructor(argv: string[], assignments: Assignment[]) {
    this.argv = argv;
    this.assignments = assignments;
  }

  get name(): string {
    return commandName(this.argv);
  }

  dropsInherited(variable: string): boolean {
    return this.clearsEnv || this.removedNames.has(variable);
  }
}

export function unwrap(command: SimpleCommand): Invocation {
  const invocation = new Invocation([...command.argv], [...command.assignments]);
  while (invocation.argv.length > 0) {
    const before = [...invocation.argv];
    dropOneWrapper(invocation);
    if (arraysEqual(invocation.argv, before)) break;
  }
  readDashedGitAsGit(invocation);
  return invocation;
}

function readDashedGitAsGit(invocation: Invocation): void {
  const program = invocation.argv[0];
  if (program === undefined || RUN_TIME_WORD_RE.test(program)) return;
  const subcommand = dashedGitSubcommand(program);
  if (subcommand) invocation.argv = ["git", subcommand, ...invocation.argv.slice(1)];
}

function dropOneWrapper(invocation: Invocation): void {
  const name = invocation.name;
  const rest = invocation.argv.slice(1);
  if (name === "time") {
    invocation.argv = commandAfterOptions(invocation, rest, TIME_FLAGS, new Set());
  } else if (name === "nohup") {
    invocation.argv = commandAfterOptions(invocation, rest, new Set(), new Set());
  } else if (name === "command" && !(rest.length > 0 && ["-v", "-V"].includes(rest[0] ?? ""))) {
    invocation.argv = commandAfterOptions(invocation, rest, COMMAND_FLAGS, new Set());
  } else if (name === "exec") {
    invocation.argv = execCommand(invocation, rest);
  } else if (name === "nice") {
    invocation.argv = niceCommand(invocation, rest);
  } else if (name === "env") {
    invocation.argv = envCommand(invocation, rest);
  } else if (name === "timeout" || name === "gtimeout") {
    const durationAndCommand = commandAfterOptions(invocation, rest, TIMEOUT_FLAGS, TIMEOUT_VALUE_OPTIONS);
    invocation.argv = durationAndCommand.slice(1);
  } else if (name === "sudo") {
    invocation.clearsEnv = true;
    invocation.argv = commandAfterOptions(invocation, rest, SUDO_FLAGS, SUDO_VALUE_OPTIONS, SUDO_MOVING_OPTIONS,
                                          SUDO_DIRECTORY_OPTIONS);
  }
}

function commandAfterOptions(invocation: Invocation, args: string[], flags: ReadonlySet<string>,
                             valueOptions: ReadonlySet<string>, movingOptions: ReadonlySet<string> = NO_OPTIONS,
                             directoryOptions: ReadonlySet<string> = NO_OPTIONS): string[] {
  return optionsAndCommand(invocation, args, flags, valueOptions, movingOptions, directoryOptions)[1];
}

function optionsAndCommand(invocation: Invocation, args: string[], flags: ReadonlySet<string>,
                           valueOptions: ReadonlySet<string>, movingOptions: ReadonlySet<string> = NO_OPTIONS,
                           directoryOptions: ReadonlySet<string> = NO_OPTIONS): [Map<string, string | null>, string[]] {
  const options = new Map<string, string | null>();
  while (args.length > 0 && (args[0] ?? "").startsWith("-")) {
    const word = args[0] ?? "";
    if (word === "--") return [options, args.slice(1)];
    if (!word.startsWith("--") && codePointLength(word) > 2) {
      const takesNext = readCluster(invocation, word, args.slice(1, 2), options, flags, valueOptions, movingOptions,
                                    directoryOptions);
      args = takesNext ? args.slice(2) : args.slice(1);
      continue;
    }
    if (directoryOptions.has(word)) {
      recordUnreadOption(invocation, word, movingOptions, valueOptions);
      args = args.slice(2);
      continue;
    }
    if (valueOptions.has(word)) {
      options.set(word, args.length > 1 ? (args[1] ?? "") : "");
      args = args.slice(2);
      continue;
    }
    const known = knownOption(word, flags, valueOptions);
    if (known) options.set(known[0], known[1]);
    else recordUnreadOption(invocation, word, movingOptions, valueOptions);
    args = args.slice(1);
  }
  return [options, args];
}

function readCluster(invocation: Invocation, word: string, nextWords: readonly string[], options: Map<string, string | null>,
                     flags: ReadonlySet<string>, valueOptions: ReadonlySet<string>, movingOptions: ReadonlySet<string>,
                     directoryOptions: ReadonlySet<string>): boolean {
  const letters = Array.from(word.slice(1));
  let record = false;
  for (const [index, letter] of letters.entries()) {
    const option = "-" + letter;
    record = record || movingOptions.has(option) || !(flags.has(option) || valueOptions.has(option));
    if (valueOptions.has(option) || directoryOptions.has(option)) {
      const attached = letters.slice(index + 1).join("");
      if (valueOptions.has(option)) options.set(option, attached || (nextWords.length > 0 ? (nextWords[0] ?? "") : ""));
      if (record) recordUnreadOption(invocation, word, movingOptions, valueOptions);
      return !attached;
    }
    if (flags.has(option)) options.set(option, null);
  }
  if (record) recordUnreadOption(invocation, word, movingOptions, valueOptions);
  return false;
}

function recordUnreadOption(invocation: Invocation, word: string, movingOptions: ReadonlySet<string>,
                            valueOptions: ReadonlySet<string>): void {
  invocation.unattributableOptions.push(word);
  if (word.startsWith("--")) {
    invocation.movesDirectory ||= movingOptions.has(partition(word, "=")[0]);
    return;
  }
  for (const letter of Array.from(word.slice(1))) {
    if (movingOptions.has("-" + letter)) {
      invocation.movesDirectory = true;
      return;
    }
    if (valueOptions.has("-" + letter)) return;
  }
}

function knownOption(word: string, flags: ReadonlySet<string>, valueOptions: ReadonlySet<string>): [string, string | null] | null {
  if (flags.has(word)) return [word, null];
  const [name, hasValue, value] = partition(word, "=");
  return word.startsWith("--") && hasValue && (flags.has(name) || valueOptions.has(name)) ? [name, value] : null;
}

function execCommand(invocation: Invocation, args: string[]): string[] {
  const [options, command] = optionsAndCommand(invocation, args, EXEC_FLAGS, EXEC_VALUE_OPTIONS);
  if (options.has("-c")) {
    invocation.clearsEnv = true;
    invocation.assignments = [];
  }
  const argv0 = options.get("-a") ?? "";
  if (mayChooseGitSubcommand(argv0)) invocation.unattributableOptions.push("-a");
  return command;
}

function mayChooseGitSubcommand(argv0: string): boolean {
  return dashedGitSubcommand(argv0) !== null || RUN_TIME_WORD_RE.test(argv0);
}

function niceCommand(invocation: Invocation, args: string[]): string[] {
  if (args.length > 0 && EXEC_NICE_ADJUSTMENT_RE.test(args[0] ?? "")) return args.slice(1);
  return commandAfterOptions(invocation, args, NO_OPTIONS, NICE_VALUE_OPTIONS);
}

function envCommand(invocation: Invocation, args: string[]): string[] {
  while (args.length > 0) {
    const word = args[0] ?? "";
    if (word === "-i" || word === "-" || word === "--ignore-environment") {
      invocation.clearsEnv = true;
      invocation.assignments = [];
      args = args.slice(1);
    } else if (word === ENV_UNSET_OPTION && args.length > 1) {
      invocation.removedNames.add(args[1] ?? "");
      args = args.slice(2);
    } else if (word.startsWith(ENV_UNSET_OPTION) && codePointLength(word) > 2) {
      invocation.removedNames.add(word.slice(2));
      args = args.slice(1);
    } else if (word === "--") {
      return args.slice(1);
    } else if (word.startsWith("-")) {
      recordUnreadOption(invocation, word, ENV_MOVING_OPTIONS, ENV_VALUE_OPTIONS);
      args = args.slice(1);
    } else if (word.includes("=") && IDENTIFIER_RE.test(partition(word, "=")[0])) {
      const [name, , value] = partition(word, "=");
      invocation.assignments.push([name, value]);
      args = args.slice(1);
    } else {
      break;
    }
  }
  return args;
}
