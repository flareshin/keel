import { basename } from "./paths.ts";
import { codePointLength, lstripChar, partition } from "./text.ts";
import { resolveDirectory } from "./variables.ts";
import type { Variables } from "./variables.ts";

const DASHED_GIT_PROGRAM_RE = /^git-([a-z0-9][a-z0-9-]*)$/;
export const GIT_VALUE_OPTIONS: ReadonlySet<string> =
  new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const MATCHING_REFSPEC = ":";
const NEGATION = "no-";
const NO_RECURSION = "no";
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

type Arity = "flag" | "value" | "optionalValue";

interface OptionSpec {
  name: string;
  short: string | null;
  arity: Arity;
}

const PUSH_OPTIONS: readonly OptionSpec[] = [
  flag("verbose", "v"), flag("quiet", "q"), valued("repo"), flag("all"), flag("branches"), flag("mirror"),
  flag("delete", "d"), flag("tags"), flag("dry-run", "n"), flag("porcelain"), flag("force", "f"),
  optionallyValued("force-with-lease"), flag("force-if-includes"), valued("recurse-submodules"), flag("thin"),
  valued("receive-pack"), valued("exec"), flag("set-upstream", "u"), flag("progress"), flag("prune"), flag("no-verify"),
  flag("follow-tags"), optionallyValued("signed"), flag("atomic"), valued("push-option", "o"), flag("ipv4", "4"), flag("ipv6", "6"),
];

function flag(name: string, short: string | null = null): OptionSpec {
  return { name, short, arity: "flag" };
}

function valued(name: string, short: string | null = null): OptionSpec {
  return { name, short, arity: "value" };
}

function optionallyValued(name: string): OptionSpec {
  return { name, short: null, arity: "optionalValue" };
}

interface OptionUse {
  name: string;
  set: boolean;
  value: string | null;
}

interface ReadOptions {
  uses: OptionUse[];
  ambiguousUses: OptionUse[];
  operands: string[];
  rejected: boolean;
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

export interface PushedRefspec {
  source: string;
  destination: string | null;
  forced: boolean;
  deletesDestination: boolean;
}

export interface PushInterpretation {
  remote: string | null;
  refspecs: PushedRefspec[];
  deletes: boolean;
  dryRun: boolean;
  tags: boolean;
  wholeRepo: boolean;
  force: boolean;
  forceWithLease: boolean;
  skipsHooks: boolean;
  recurseSubmodules: string | null;
}

export function interpretPush(args: readonly string[]): PushInterpretation {
  const read = readOptions(args, PUSH_OPTIONS);
  const [remoteWord, ...refspecWords] = read.operands;
  const refspecs = refspecWords.map((word): PushedRefspec => {
    const spec = lstripChar(word, "+");
    const [source, , destination] = partition(spec, ":");
    const deletesDestination = spec.startsWith(":") && spec !== MATCHING_REFSPEC;
    return { source, destination: destination || null, forced: word.startsWith("+"), deletesDestination };
  });
  const allowsPass = (name: string) => !read.rejected && lastSet(read.uses, name);
  const mayDeny = (name: string) => lastSet(read.uses, name) || read.ambiguousUses.some((use) => use.name === name && use.set);
  const mirror = mayDeny("mirror");
  const pushesMatchingBranches = refspecWords.some((word) => lstripChar(word, "+") === MATCHING_REFSPEC);
  return {
    remote: remoteWord ?? lastValue(read.uses, "repo"),
    refspecs,
    deletes: allowsPass("delete"),
    dryRun: allowsPass("dry-run"),
    tags: allowsPass("tags"),
    wholeRepo: mirror || mayDeny("all") || mayDeny("branches") || pushesMatchingBranches,
    force: mirror || mayDeny("force"),
    forceWithLease: mayDeny("force-with-lease"),
    skipsHooks: mayDeny("no-verify"),
    recurseSubmodules: recursion(read.uses),
  };
}

function lastUse(uses: readonly OptionUse[], name: string): OptionUse | null {
  return uses.findLast((use) => use.name === name) ?? null;
}

function lastSet(uses: readonly OptionUse[], name: string): boolean {
  return lastUse(uses, name)?.set ?? false;
}

function lastValue(uses: readonly OptionUse[], name: string): string | null {
  const use = lastUse(uses, name);
  return use?.set ? use.value : null;
}

function recursion(uses: readonly OptionUse[]): string | null {
  const use = lastUse(uses, "recurse-submodules");
  if (use === null) return null;
  return use.set ? use.value : NO_RECURSION;
}

function readOptions(args: readonly string[], specs: readonly OptionSpec[]): ReadOptions {
  const read: ReadOptions = { uses: [], ambiguousUses: [], operands: [], rejected: false };
  const words = args.values();
  for (const word of words) {
    if (word === "--") read.operands.push(...words);
    else if (word.startsWith("--")) readLongOption(word.slice(2), words, specs, read);
    else if (word.startsWith("-") && word !== "-") readShortOptions(word.slice(1), words, specs, read);
    else read.operands.push(word);
  }
  return read;
}

function readLongOption(text: string, words: IteratorObject<string>, specs: readonly OptionSpec[], read: ReadOptions): void {
  const [spelled, hasValue, attached] = partition(text, "=");
  const readings = longReadings(spelled, specs);
  if (readings.length !== 1) {
    read.rejected = true;
    read.ambiguousUses.push(...readings);
    return;
  }
  const [reading] = readings as [OptionUse];
  const spec = specs.find((candidate) => candidate.name === reading.name)!;
  if (!reading.set || spec.arity === "flag") {
    if (hasValue) read.rejected = true;
    else read.uses.push(reading);
    return;
  }
  const value = hasValue ? attached : spec.arity === "value" ? nextWord(words) : null;
  if (spec.arity === "value" && value === null) read.rejected = true;
  read.uses.push({ ...reading, value });
}

function longReadings(spelled: string, specs: readonly OptionSpec[]): OptionUse[] {
  const exact = specs.flatMap((spec) => exactReadings(spelled, spec));
  return exact.length > 0 ? exact : specs.flatMap((spec) => abbreviatedReadings(spelled, spec));
}

function exactReadings(spelled: string, spec: OptionSpec): OptionUse[] {
  if (spelled === spec.name) return [use(spec, true)];
  if (spelled === NEGATION + spec.name || spelled === negatedName(spec)) return [use(spec, false)];
  return [];
}

function abbreviatedReadings(spelled: string, spec: OptionSpec): OptionUse[] {
  const readings: OptionUse[] = [];
  if (spec.name.startsWith(spelled)) readings.push(use(spec, true));
  const abbreviatesNegation = NEGATION.startsWith(spelled) ||
    (spelled.startsWith(NEGATION) && spec.name.startsWith(spelled.slice(NEGATION.length)));
  if (abbreviatesNegation || negatedName(spec)?.startsWith(spelled)) readings.push(use(spec, false));
  return readings;
}

function negatedName(spec: OptionSpec): string | null {
  return spec.name.startsWith(NEGATION) ? spec.name.slice(NEGATION.length) : null;
}

function use(spec: OptionSpec, set: boolean): OptionUse {
  return { name: spec.name, set, value: null };
}

function readShortOptions(cluster: string, words: IteratorObject<string>, specs: readonly OptionSpec[], read: ReadOptions): void {
  const letters = Array.from(cluster);
  for (const [position, letter] of letters.entries()) {
    const spec = specs.find((candidate) => candidate.short === letter);
    if (spec === undefined) {
      read.rejected = true;
      return;
    }
    if (spec.arity === "flag") {
      read.uses.push(use(spec, true));
      continue;
    }
    const value = letters.slice(position + 1).join("") || nextWord(words);
    if (value === null) read.rejected = true;
    read.uses.push({ ...use(spec, true), value });
    return;
  }
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
