import { basename, expandUser, expandVars, joinPath } from "./paths.ts";
import { isDigits, partition, rstripChar, SPACE_CHARS, WORD_CHARS } from "./text.ts";
import { unwrap } from "./commands.ts";
import type { Redirect, SimpleCommand } from "./commands.ts";
import { gitSubcommand } from "./gitargs.ts";
import { parseCommands } from "./parser.ts";

const FILE_WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const APPENDING_REDIRECTS: ReadonlySet<string> = new Set([">>", "&>>"]);
const COPY_VERBS: ReadonlySet<string> = new Set(["cp", "mv", "install", "ln", "rsync"]);
const REMOVE_VERBS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred"]);
const CREATE_VERBS: ReadonlySet<string> = new Set(["touch", "truncate", "tee"]);
const IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl"]);
const VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cp", new Set(["-t", "-S"])],
  ["mv", new Set(["-t", "-S"])],
  ["install", new Set(["-t", "-m", "-o", "-g", "-S"])],
  ["ln", new Set(["-t", "-S"])],
  ["truncate", new Set(["-s", "-r"])],
  ["sed", new Set(["-e", "-f"])],
  ["perl", new Set(["-e", "-E", "-M", "-I"])],
]);
const NOT_WORD_BEFORE = `(?<![${WORD_CHARS}])`;
const SPACE = `[${SPACE_CHARS}]`;
const INLINE_WRITE_RE = new RegExp(
  String.raw`${NOT_WORD_BEFORE}open\((?:[^()\n]|\([^()\n]*\))*,${SPACE}*(?:mode${SPACE}*=${SPACE}*)?['"][wax][tb+]*['"]` +
  String.raw`|\.open\(${SPACE}*(?:mode${SPACE}*=${SPACE}*)?['"][wax][tb+]*['"]` +
  String.raw`|\.write_(?:text|bytes)\(|${NOT_WORD_BEFORE}(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\(`,
  "u",
);
const SED_SCRIPT_OPTION_RE = /^-[a-zA-Z]*[ef]/;

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

function redirectTargets(command: SimpleCommand): string[] {
  return command.redirects
    .filter((redirect) => redirect.target !== "/dev/null" && fileWriteOf(redirect) !== null)
    .map((redirect) => redirect.target);
}

export function fileWriteOf(redirect: Redirect): { target: string; appends: boolean } | null {
  const duplicatesToAFile = redirect.op === ">&" && !(isDigits(redirect.target) || redirect.target === "-");
  if (!FILE_WRITE_REDIRECTS.has(redirect.op) && !duplicatesToAFile) return null;
  return { target: redirect.target, appends: APPENDING_REDIRECTS.has(redirect.op) };
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

export function operands(verb: string, args: readonly string[]): string[] {
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
