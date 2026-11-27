import { partition } from "./text.ts";
import { commandName, unwrap } from "./commands.ts";
import type { Assignment, Invocation, SimpleCommand } from "./commands.ts";
import { parseCommands } from "./parser.ts";
import { callValue, expandVariables, PREVIOUS_DIRECTORY, resolveDirectory } from "./variables.ts";
import type { Variables } from "./variables.ts";

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
  const previousUntrustedAt = new Map<SimpleCommand, boolean>();
  for (const command of parseCommands(text)) {
    const script = command.parent;
    let scope = scopes.get(script);
    if (scope === undefined) {
      const owner = script === null ? undefined : stepOf.get(script);
      if (owner === undefined) throw new Error("a nested command precedes the command it came from");
      scope = new ShellScope(owner.directory, owner.environment, previousUntrustedAt.get(script) ?? true);
      scopes.set(script, scope);
    }
    const invocation = unwrap(command);
    const environment: Variables = invocation.clearsEnv ? new Map() : new Map(scope.exported);
    for (const [name, value] of invocation.assignments) environment.set(name, value);
    previousUntrustedAt.set(command, scope.previousUntrusted);
    stepOf.set(command, new Step(invocation.argv, environment, scope.directory, command, scope.expansion(),
                                 invocation.unattributableOptions));
    scope.follow(invocation, command);
  }
  return Array.from(stepOf.values());
}

class ShellScope {
  directory: string;
  exported: Variables;
  variables: Variables = new Map();
  pushed: string[] = [];
  previous: string | null = null;
  receivesPipe = false;
  previousUntrusted: boolean;

  constructor(directory: string, exported: Variables, previousUntrusted = false) {
    this.directory = directory;
    this.exported = new Map(exported);
    this.previousUntrusted = previousUntrusted;
  }

  expansion(): Variables {
    return new Map([...this.variables, ...this.exported]);
  }

  follow(invocation: Invocation, command: SimpleCommand): void {
    const name = invocation.name;
    const args = invocation.argv.slice(1);
    const runsInThisShell = !this.receivesPipe && command.argv[0] === invocation.argv[0];
    this.receivesPipe = command.pipesToNext;
    const keepsPrevious = runsInThisShell && isModeledDirectoryMove(invocation);
    if (!keepsPrevious) this.previous = null;
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
    if (!keepsPrevious) this.previous = null;
    if (!keepsPrevious && (invocation.argv.length > 0 || setsDirectoryLookup(invocation.assignments))) {
      this.previousUntrusted = true;
    }
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
    this.previous = this.previousUntrusted ? null : this.directory;
    this.directory = directory;
  }

  private changedDirectory(args: readonly string[]): string {
    const target = args.length > 0 ? (args[0] ?? "") : "~";
    if (target !== "-") return resolveDirectory(this.directory, target, this.expansion());
    return this.previous ?? resolveDirectory(this.directory, "$" + PREVIOUS_DIRECTORY, new Map());
  }
}

function setsDirectoryLookup(assignments: readonly Assignment[]): boolean {
  return assignments.some(([variable]) => variable === "CDPATH" || variable === "HOME");
}

function isModeledDirectoryMove(invocation: Invocation): boolean {
  if (invocation.assignments.length > 0) return false;
  const args = invocation.argv.slice(1);
  const isOption = (word: string) => word.startsWith("-") || word.startsWith("+");
  switch (invocation.name) {
    case "cd":
      return args.length === 0 || (args.length === 1 && (args[0] === "-" || !isOption(args[0] ?? "")));
    case "pushd":
      return args.length === 1 && !isOption(args[0] ?? "");
    case "popd":
      return args.length === 0;
    default:
      return false;
  }
}
