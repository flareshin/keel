import { partition } from "./text.ts";
import { commandName, unwrap } from "./commands.ts";
import type { Assignment, Invocation, SimpleCommand } from "./commands.ts";
import { parseCommands } from "./parser.ts";
import { callValue, expandVariables, resolveDirectory } from "./variables.ts";
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

  private changedDirectory(args: readonly string[]): string {
    const target = args.length > 0 ? (args[0] ?? "") : "~";
    if (target === "-") return this.directory;
    return resolveDirectory(this.directory, target, this.expansion());
  }
}
