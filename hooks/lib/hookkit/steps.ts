import { partition } from "./text.ts";
import { commandName, unwrap } from "./commands.ts";
import type { Assignment, Invocation, SimpleCommand } from "./commands.ts";
import { parseCommands } from "./parser.ts";
import { callValue, expandVariables, PREVIOUS_DIRECTORY, resolveDirectory } from "./variables.ts";
import type { Variables } from "./variables.ts";

const UNFOLLOWED_COMMANDS = new Set(["eval", "source", ".", "trap", "builtin"]);

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
  previous: string | null = null;

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
    const previousMayMoveUnseen = mayMovePreviousDirectoryUnseen(invocation);
    if (previousMayMoveUnseen) this.previous = null;
    if (name === "cd") {
      this.moveTo(this.changedDirectory(args));
    } else if (name === "pushd" && args.length > 0) {
      this.pushed.push(this.directory);
      this.moveTo(this.changedDirectory(args));
    } else if (name === "popd" && this.pushed.length > 0) {
      this.moveTo(this.pushed.pop() ?? this.directory);
    } else if (name === "export") {
      this.exportAll(args);
    } else if (invocation.argv.length === 0) {
      this.assign(invocation.assignments);
    }
    if (previousMayMoveUnseen) this.previous = null;
  }

  private exportAll(args: readonly string[]): void {
    const before = this.expansion();
    for (const arg of args) {
      const [variable, hasValue, value] = partition(arg, "=");
      if (hasValue) {
        this.exported.set(variable, this.expandedValue(value, before));
      } else if (this.variables.has(variable)) {
        this.exported.set(variable, this.variables.get(variable) ?? "");
        this.variables.delete(variable);
      }
    }
  }

  private assign(assignments: readonly Assignment[]): void {
    for (const [variable, value] of assignments) {
      const target = this.exported.has(variable) ? this.exported : this.variables;
      target.set(variable, this.expandedValue(value, this.expansion()));
    }
  }

  private expandedValue(value: string, variables: Variables): string {
    return expandVariables(value, (name) => callValue(name, this.directory, variables));
  }

  private moveTo(directory: string): void {
    this.previous = this.directory;
    this.directory = directory;
  }

  private changedDirectory(args: readonly string[]): string {
    const target = args.length > 0 ? (args[0] ?? "") : "~";
    if (target !== "-") return resolveDirectory(this.directory, target, this.expansion());
    return this.previous ?? resolveDirectory(this.directory, "$" + PREVIOUS_DIRECTORY, new Map());
  }
}

function mayMovePreviousDirectoryUnseen(invocation: Invocation): boolean {
  const name = invocation.name;
  if (UNFOLLOWED_COMMANDS.has(name) || !directoryMoveIsModeled(name, invocation.argv.slice(1))) return true;
  const words = [...invocation.argv, ...invocation.assignments.flat()];
  return words.some((word) => word.includes(PREVIOUS_DIRECTORY));
}

function directoryMoveIsModeled(name: string, args: readonly string[]): boolean {
  const isOption = (word: string) => word.startsWith("-") || word.startsWith("+");
  if (name === "cd") return args.length === 0 || (args.length === 1 && (args[0] === "-" || !isOption(args[0] ?? "")));
  if (name === "pushd") return args.length === 1 && !isOption(args[0] ?? "");
  if (name === "popd") return args.length === 0;
  return true;
}
