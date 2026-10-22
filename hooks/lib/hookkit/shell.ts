import {
  arraysEqual, basename, codePointLength, expandUser, expandVars, isDigits, joinPath, lstripChar, normalizePath, partition,
  PY_SPACE, PY_WORD, rstripChar,
} from "./pycompat.ts";

export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
export const SEPARATOR_OPS: readonly string[] = ["&&", "||", "|&", ";;", ";", "|", "&", "(", ")"];
export const REDIRECT_OPS: readonly string[] = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<>", "<&", ">", "<"];
const PIPE_OPS: ReadonlySet<string> = new Set(["|", "|&"]);
export const WORD_BREAK: ReadonlySet<string> = new Set(" \t\n;&|()<>");
export const KEYWORDS_AT_COMMAND_START: ReadonlySet<string> =
  new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{", "}", "esac"]);
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEREDOC_START_RE = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/y;

const FILE_WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const COPY_VERBS: ReadonlySet<string> = new Set(["cp", "mv", "install", "ln", "rsync"]);
const REMOVE_VERBS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred"]);
const CREATE_VERBS: ReadonlySet<string> = new Set(["touch", "truncate", "tee"]);
const IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl"]);
const DASHED_GIT_PROGRAM_RE = /^git-([a-z0-9][a-z0-9-]*)$/;
const RUN_TIME_WORD_RE = /[$`]/;
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
export const GIT_VALUE_OPTIONS: ReadonlySet<string> =
  new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--push-option", "--receive-pack", "--exec"]);
const PUSH_OPTION_LETTER = "o";
const PUSH_REPO_OPTION = "--repo";
const WHOLE_REPO_PUSH_OPTIONS: ReadonlySet<string> = new Set(["--all", "--branches", "--mirror"]);
const GH_REPO_OPTIONS: ReadonlySet<string> = new Set(["-R", "--repo"]);
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
const VARIABLE_RE = new RegExp(String.raw`\$\{([${PY_WORD}]+)\}|\$([${PY_WORD}]+)`, "gu");
const VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cp", new Set(["-t", "-S"])],
  ["mv", new Set(["-t", "-S"])],
  ["install", new Set(["-t", "-m", "-o", "-g", "-S"])],
  ["ln", new Set(["-t", "-S"])],
  ["truncate", new Set(["-s", "-r"])],
  ["sed", new Set(["-e", "-f"])],
  ["perl", new Set(["-e", "-E", "-M", "-I"])],
]);
const NOT_WORD_BEFORE = `(?<![${PY_WORD}])`;
const SPACE = `[${PY_SPACE}]`;
const INLINE_WRITE_RE = new RegExp(
  String.raw`${NOT_WORD_BEFORE}open\((?:[^()\n]|\([^()\n]*\))*,${SPACE}*(?:mode${SPACE}*=${SPACE}*)?['"][wax][tb+]*['"]` +
  String.raw`|\.open\(${SPACE}*(?:mode${SPACE}*=${SPACE}*)?['"][wax][tb+]*['"]` +
  String.raw`|\.write_(?:text|bytes)\(|${NOT_WORD_BEFORE}(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\(`,
  "u",
);
const EXEC_NICE_ADJUSTMENT_RE = /^--?\p{Nd}+$/u;
const SHELL_CODE_OPTION_RE = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const SED_SCRIPT_OPTION_RE = /^-[a-zA-Z]*[ef]/;
const ASSIGNMENT_NAME_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export type Assignment = readonly [name: string, value: string];
export type Variables = Map<string, string>;

export interface Redirect {
  op: string;
  target: string;
}

function commandName(argv: readonly string[]): string {
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

export class Step {
  argv: string[];
  environment: Variables;
  directory: string;
  command: SimpleCommand;
  expansion: Variables;
  unattributableOptions: string[];

  constructor(argv: string[], environment: Variables, directory: string, command: SimpleCommand,
              expansion: Variables = new Map(), unattributableOptions: string[] = []) {
    this.argv = argv;
    this.environment = environment;
    this.directory = directory;
    this.command = command;
    this.expansion = expansion;
    this.unattributableOptions = unattributableOptions;
  }

  get name(): string {
    return commandName(this.argv);
  }

  get heredocs(): string[] {
    return this.command.heredocs;
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

export class PushArguments {
  remote: string | null = null;
  refspecs: string[] = [];
  longOptions: string[] = [];
  shortFlags = "";

  get wholeRepo(): boolean {
    return this.longOptions.some((option) => WHOLE_REPO_PUSH_OPTIONS.has(option));
  }
}

export class WriteTargets {
  written: string[] = [];
  removed: string[] = [];
  sources: string[] = [];
  unknown = false;

  constructor(written: string[] = []) {
    this.written = written;
  }

  any(): boolean {
    return this.written.length > 0 || this.removed.length > 0 || this.unknown;
  }
}

export function parseCommands(text: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  new Reader(text, false, commands).read();
  expandCodeStrings(commands);
  return commands;
}

export function steps(text: string, cwd: string): Step[] {
  const scopes = new Map<SimpleCommand | null, ShellScope>([[null, new ShellScope(cwd, new Map())]]);
  const stepOf = new Map<SimpleCommand, Step>();
  for (const command of parseCommands(text)) {
    const script = command.parent;
    let scope = scopes.get(script);
    if (scope === undefined) {
      const owner = script === null ? undefined : stepOf.get(script);
      if (owner === undefined) throw new Error("a nested command precedes the command it came from");
      scope = new ShellScope(owner.directory, owner.environment);
      scopes.set(script, scope);
    }
    const invocation = unwrap(command);
    const environment: Variables = invocation.clearsEnv ? new Map() : new Map(scope.exported);
    for (const [name, value] of invocation.assignments) environment.set(name, value);
    stepOf.set(command, new Step(invocation.argv, environment, scope.directory, command, scope.expansion(),
                                 invocation.unattributableOptions));
    scope.follow(invocation);
  }
  return Array.from(stepOf.values());
}

class ShellScope {
  directory: string;
  exported: Variables;
  variables: Variables = new Map();
  pushed: string[] = [];

  constructor(directory: string, exported: Variables) {
    this.directory = directory;
    this.exported = new Map(exported);
  }

  expansion(): Variables {
    return new Map([...this.variables, ...this.exported]);
  }

  follow(invocation: Invocation): void {
    const name = invocation.name;
    const args = invocation.argv.slice(1);
    if (name === "cd") {
      this.directory = this.changedDirectory(args);
    } else if (name === "pushd" && args.length > 0) {
      this.pushed.push(this.directory);
      this.directory = this.changedDirectory(args);
    } else if (name === "popd" && this.pushed.length > 0) {
      this.directory = this.pushed.pop() ?? this.directory;
    } else if (name === "export") {
      this.exportAll(args);
    } else if (invocation.argv.length === 0) {
      this.assign(invocation.assignments);
    }
  }

  private exportAll(args: readonly string[]): void {
    for (const arg of args) {
      const [variable, hasValue, value] = partition(arg, "=");
      if (hasValue) {
        this.exported.set(variable, value);
      } else if (this.variables.has(variable)) {
        this.exported.set(variable, this.variables.get(variable) ?? "");
        this.variables.delete(variable);
      }
    }
  }

  private assign(assignments: readonly Assignment[]): void {
    for (const [variable, value] of assignments) {
      const target = this.exported.has(variable) ? this.exported : this.variables;
      target.set(variable, value);
    }
  }

  private changedDirectory(args: readonly string[]): string {
    const target = args.length > 0 ? (args[0] ?? "") : "~";
    if (target === "-") return this.directory;
    return resolveDirectory(this.directory, target, this.expansion());
  }
}

export function resolveDirectory(directory: string, target: string, environment: Variables): string {
  const lookup = (name: string): string | undefined => {
    if (environment.has(name)) return environment.get(name);
    if (name === "PWD") return directory;
    if (name === "OLDPWD") return undefined;
    return Object.hasOwn(process.env, name) ? process.env[name] : undefined;
  };
  const expanded = target.replace(VARIABLE_RE, (whole, braced: string | undefined, bare: string | undefined) =>
    lookup(braced ?? bare ?? "") ?? whole);
  return normalizePath(joinPath(directory, expandUser(expanded)));
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

function nextWord(words: IteratorObject<string>): string | null {
  const next = words.next();
  return next.done ? null : next.value;
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

export function writeTargets(command: SimpleCommand): WriteTargets {
  const targets = new WriteTargets(redirectTargets(command));
  const invocation = unwrap(command);
  const verb = invocation.name;
  const args = invocation.argv.slice(1);
  if (COPY_VERBS.has(verb)) {
    addCopyTargets(targets, verb, args);
  } else if (REMOVE_VERBS.has(verb)) {
    targets.removed.push(...operands(verb, args));
  } else if (CREATE_VERBS.has(verb)) {
    targets.written.push(...operands(verb, args));
  } else if (IN_PLACE_EDITORS.has(verb) && editsInPlace(verb, args)) {
    targets.written.push(...editedFiles(verb, args));
  } else if (verb === "dd") {
    targets.written.push(...args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice("of=".length)));
  } else if (verb === "patch" || ["apply", "am"].includes(gitSubcommand(invocation.argv) ?? "")) {
    targets.unknown = true;
  }
  return targets;
}

export function commandWritesFiles(text: string, exceptUnder: readonly string[] = []): boolean {
  if (INLINE_WRITE_RE.test(text)) return true;
  for (const command of parseCommands(text)) {
    const targets = writeTargets(command);
    const expanded = [...targets.written, ...targets.removed].map((path) => expandUser(expandVars(path)));
    if (targets.unknown || expanded.some((path) => !exceptUnder.some((prefix) => path.startsWith(prefix)))) return true;
  }
  return false;
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

function gitSubcommand(argv: readonly string[]): string | null {
  const index = gitSubcommandIndex(argv);
  return index === null ? null : (argv[index] ?? null);
}

function redirectTargets(command: SimpleCommand): string[] {
  return command.redirects
    .filter((redirect) => redirect.target !== "/dev/null" && (FILE_WRITE_REDIRECTS.has(redirect.op) || (
      redirect.op === ">&" && !(isDigits(redirect.target) || redirect.target === "-"))))
    .map((redirect) => redirect.target);
}

function addCopyTargets(targets: WriteTargets, verb: string, args: readonly string[]): void {
  const explicitDir = targetDirectoryOption(args);
  const files = operands(verb, args);
  let destination: string | null;
  let sources: string[];
  if (explicitDir) {
    destination = explicitDir;
    sources = files;
  } else if (files.length >= 2) {
    destination = files[files.length - 1] ?? null;
    sources = files.slice(0, -1);
  } else {
    destination = null;
    sources = [];
  }
  if (destination) {
    const landedIfDirectory = sources.map((source) => joinPath(destination, basename(rstripChar(source, "/"))));
    targets.written.push(destination, ...landedIfDirectory);
  }
  targets.sources.push(...sources);
  if (verb === "mv") targets.removed.push(...sources);
}

function targetDirectoryOption(args: readonly string[]): string | null {
  for (const [index, arg] of args.entries()) {
    if (arg === "-t" && index + 1 < args.length) return args[index + 1] ?? null;
    if (arg.startsWith("--target-directory=")) return partition(arg, "=")[2];
  }
  return null;
}

function operands(verb: string, args: readonly string[]): string[] {
  const takesValue = VALUE_OPTIONS.get(verb) ?? new Set<string>();
  const found: string[] = [];
  let index = 0;
  let optionsDone = false;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (!optionsDone && arg === "--") {
      optionsDone = true;
    } else if (!optionsDone && takesValue.has(arg)) {
      index += 1;
    } else if (optionsDone || !arg.startsWith("-") || arg === "-") {
      found.push(arg);
    }
    index += 1;
  }
  return found;
}

function editedFiles(verb: string, args: readonly string[]): string[] {
  const files = operands(verb, args).filter((operand) => operand !== "");
  if (verb === "sed" && !namesSedScriptOption(args)) return files.slice(1);
  return files;
}

function namesSedScriptOption(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith("--e") || arg.startsWith("--fi") || SED_SCRIPT_OPTION_RE.test(arg));
}

function editsInPlace(verb: string, args: readonly string[]): boolean {
  const cluster = verb === "sed" ? /^-[a-zA-Z]*[iI]/ : /^-[a-zA-Z]*[i]/;
  return args.some((arg) => arg.startsWith("--in-place") || (cluster.test(arg) && !arg.startsWith("--")));
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

const NO_OPTIONS: ReadonlySet<string> = new Set();

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

function expandCodeStrings(commands: SimpleCommand[]): void {
  let index = 0;
  while (index < commands.length) {
    const command = commands[index] as SimpleCommand;
    for (const code of codeStrings(commands, index)) {
      const nested: SimpleCommand[] = [];
      new Reader(code, true, nested, command).read();
      commands.push(...nested);
    }
    index += 1;
  }
}

function codeStrings(commands: readonly SimpleCommand[], index: number): string[] {
  const command = commands[index] as SimpleCommand;
  const invocation = unwrap(command);
  const name = invocation.name;
  const args = invocation.argv.slice(1);
  if (name === "eval") return [args.join(" ")];
  if ((name === "source" || name === ".") && args.length > 0 && ["/dev/stdin", "/dev/fd/0"].includes(args[0] ?? "")) {
    return [...command.heredocs];
  }
  if (!SHELLS.has(name)) return [];
  for (const [position, arg] of args.entries()) {
    if (SHELL_CODE_OPTION_RE.test(arg) && position + 1 < args.length) return [args[position + 1] ?? ""];
  }
  const runsScriptFile = args.some((arg) => !arg.startsWith("-"));
  if (runsScriptFile) return [];
  const hereStrings = command.redirects.filter((redirect) => redirect.op === "<<<").map((redirect) => redirect.target);
  return [...command.heredocs, ...hereStrings, ...heredocsPipedInto(commands, index)];
}

function heredocsPipedInto(commands: readonly SimpleCommand[], index: number): string[] {
  let bodies: string[] = [];
  let previous = index - 1;
  while (previous >= 0 && (commands[previous] as SimpleCommand).pipesToNext) {
    bodies = [...(commands[previous] as SimpleCommand).heredocs, ...bodies];
    previous -= 1;
  }
  return bodies;
}

interface PendingHeredoc {
  command: SimpleCommand;
  delimiter: string;
  stripTabs: boolean;
}

class Reader {
  text: string;
  position = 0;
  nested: boolean;
  out: SimpleCommand[];
  parent: SimpleCommand | null;
  substitutions: Array<[string, SimpleCommand]> = [];
  pendingHeredocs: PendingHeredoc[] = [];
  current: SimpleCommand;

  constructor(text: string, nested: boolean, out: SimpleCommand[], parent: SimpleCommand | null = null) {
    this.text = text;
    this.nested = nested;
    this.out = out;
    this.parent = parent;
    this.current = new SimpleCommand(nested, parent);
  }

  read(): void {
    while (this.position < this.text.length) this.readNext();
    this.finishCommand(false);
    for (const [body, owner] of this.substitutions) new Reader(body, true, this.out, owner).read();
  }

  private readNext(): void {
    const text = this.text;
    const position = this.position;
    const char = text[position] ?? "";
    if (text.startsWith("\\\n", position)) {
      this.position += 2;
    } else if (char === "\n") {
      this.finishCommand(false);
      this.position += 1;
      this.readHeredocBodies();
    } else if (char === " " || char === "\t") {
      this.position += 1;
    } else if (char === "#") {
      const end = text.indexOf("\n", position);
      this.position = end < 0 ? text.length : end;
    } else if (text.startsWith("<(", position) || text.startsWith(">(", position)) {
      const [body, end] = readBalanced(text, position + 2);
      this.position = end;
      this.ownSubstitutions([body]);
      this.addWord(text.slice(position, this.position), true);
    } else if (this.readOperator()) {
      return;
    } else {
      this.readWordOrFd();
    }
  }

  private readOperator(): boolean {
    const text = this.text;
    const position = this.position;
    for (const op of REDIRECT_OPS) {
      if (text.startsWith(op, position) && !text.startsWith("&&", position)) {
        this.position += op.length;
        this.readRedirectTarget(op);
        return true;
      }
    }
    for (const op of SEPARATOR_OPS) {
      if (text.startsWith(op, position)) {
        this.position += op.length;
        this.finishCommand(PIPE_OPS.has(op));
        return true;
      }
    }
    return false;
  }

  private readRedirectTarget(op: string): void {
    while (this.position < this.text.length && (this.text[this.position] === " " || this.text[this.position] === "\t")) {
      this.position += 1;
    }
    const [word, , end] = this.readWordHere();
    this.position = end;
    if (op === "<<" || op === "<<-") {
      this.pendingHeredocs.push({ command: this.current, delimiter: word, stripTabs: op === "<<-" });
      return;
    }
    this.current.redirects.push({ op, target: word });
  }

  private readWordOrFd(): void {
    const start = this.position;
    const [word, quoted, end] = this.readWordHere();
    this.position = end;
    const isFdNumber = isDigits(word) && !quoted && ["<", ">"].includes(this.text.slice(this.position, this.position + 1));
    if (!isFdNumber) this.addWord(word, quoted, assignmentName(this.text.slice(start, this.position)));
  }

  private readWordHere(): [string, boolean, number] {
    const found: string[] = [];
    const result = readWord(this.text, this.position, found);
    this.ownSubstitutions(found);
    return result;
  }

  private ownSubstitutions(bodies: readonly string[]): void {
    for (const body of bodies) this.substitutions.push([body, this.current]);
  }

  private addWord(word: string, quoted: boolean, name: string | null = null): void {
    const command = this.current;
    const atStart = command.argv.length === 0;
    if (atStart && command.assignments.length === 0 && !quoted && KEYWORDS_AT_COMMAND_START.has(word)) return;
    if (atStart && name) {
      command.assignments.push([name, word.slice(name.length + 1)]);
      return;
    }
    command.argv.push(word);
  }

  private finishCommand(pipesToNext: boolean): void {
    if (this.current.argv.length > 0 || this.current.assignments.length > 0 || this.current.redirects.length > 0) {
      this.current.pipesToNext = pipesToNext;
      this.out.push(this.current);
    }
    this.current = new SimpleCommand(this.nested, this.parent);
  }

  private readHeredocBodies(): void {
    for (const { command, delimiter, stripTabs } of this.pendingHeredocs) {
      const [body, end] = readHeredocBody(this.text, this.position, delimiter, stripTabs);
      this.position = end;
      command.heredocs.push(body);
    }
    this.pendingHeredocs = [];
  }
}

function assignmentName(rawWord: string): string | null {
  return ASSIGNMENT_NAME_RE.exec(rawWord)?.[1] ?? null;
}

function readWord(text: string, start: number, substitutions: string[]): [string, boolean, number] {
  const parts: string[] = [];
  let quoted = false;
  let position = start;
  while (position < text.length) {
    const char = text[position] ?? "";
    if (WORD_BREAK.has(char)) break;
    if (char === "\\") {
      if (text.startsWith("\\\n", position)) {
        position += 2;
        continue;
      }
      parts.push(text.slice(position + 1, position + 2));
      position += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", position + 1);
      const end = close < 0 ? text.length : close;
      parts.push(text.slice(position + 1, end));
      quoted = true;
      position = end + 1;
    } else if (char === '"') {
      const [content, end] = readDoubleQuoted(text, position + 1, substitutions);
      parts.push(content);
      quoted = true;
      position = end;
    } else if (text.startsWith("$((", position)) {
      const [, end] = readBalanced(text, position + 2);
      parts.push(text.slice(position, end));
      position = end;
    } else if (text.startsWith("${", position)) {
      const close = text.indexOf("}", position);
      const end = close < 0 ? text.length : close + 1;
      parts.push(text.slice(position, end));
      position = end;
    } else {
      const substitution = readSubstitution(text, position, substitutions);
      if (substitution) {
        parts.push(substitution[0]);
        position = substitution[1];
      } else {
        parts.push(char);
        position += 1;
      }
    }
  }
  return [parts.join(""), quoted, position];
}

function readDoubleQuoted(text: string, start: number, substitutions: string[]): [string, number] {
  const parts: string[] = [];
  let position = start;
  while (position < text.length) {
    const char = text[position] ?? "";
    if (char === '"') return [parts.join(""), position + 1];
    if (char === "\\" && position + 1 < text.length) {
      const following = text[position + 1] ?? "";
      parts.push(['"', "\\", "$", "`"].includes(following) ? following : "\\" + following);
      position += 2;
    } else {
      const substitution = readSubstitution(text, position, substitutions);
      if (substitution) {
        parts.push(substitution[0]);
        position = substitution[1];
      } else {
        parts.push(char);
        position += 1;
      }
    }
  }
  return [parts.join(""), position];
}

function readSubstitution(text: string, position: number, substitutions: string[]): [string, number] | null {
  let body: string;
  let verbatim: string;
  let end: number;
  if (text.startsWith("$(", position) && !text.startsWith("$((", position)) {
    [body, end] = readBalanced(text, position + 2);
    verbatim = text.slice(position, end);
  } else if (text[position] === "`") {
    const found = text.indexOf("`", position + 1);
    const close = found < 0 ? text.length : found;
    body = text.slice(position + 1, close);
    verbatim = text.slice(position, close + 1);
    end = close + 1;
  } else {
    return null;
  }
  substitutions.push(body);
  return [verbatim, end];
}

function matchHeredocStart(text: string, position: number): RegExpExecArray | null {
  HEREDOC_START_RE.lastIndex = position;
  return HEREDOC_START_RE.exec(text);
}

function readBalanced(text: string, start: number): [string, number] {
  let depth = 1;
  let position = start;
  let pendingDelimiters: Array<[delimiter: string, stripTabs: boolean]> = [];
  while (position < text.length) {
    const char = text[position];
    const heredoc = matchHeredocStart(text, position);
    if (heredoc) {
      const delimiter = heredoc.slice(2, 5).find((group) => group !== undefined) ?? "";
      pendingDelimiters.push([delimiter, heredoc[1] === "-"]);
      position = heredoc.index + heredoc[0].length;
    } else if (char === "\n" && pendingDelimiters.length > 0) {
      position += 1;
      for (const [delimiter, stripTabs] of pendingDelimiters) {
        [, position] = readHeredocBody(text, position, delimiter, stripTabs);
      }
      pendingDelimiters = [];
    } else if (char === "\\") {
      position += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", position + 1);
      position = close < 0 ? text.length : close + 1;
    } else if (char === '"') {
      [, position] = readDoubleQuoted(text, position + 1, []);
    } else if (char === "(") {
      depth += 1;
      position += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return [text.slice(start, position), position + 1];
      position += 1;
    } else {
      position += 1;
    }
  }
  return [text.slice(start), text.length];
}

function readHeredocBody(text: string, start: number, delimiter: string, stripTabs: boolean): [string, number] {
  const lines: string[] = [];
  let position = start;
  while (position < text.length) {
    const found = text.indexOf("\n", position);
    const end = found < 0 ? text.length : found;
    const line = text.slice(position, end);
    position = end + 1;
    if ((stripTabs ? lstripChar(line, "\t") : line) === delimiter) return [lines.join("\n"), position];
    lines.push(line);
  }
  return [lines.join("\n"), text.length];
}
