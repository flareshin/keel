import { overlayPath } from "../../../hooks/lib/hookkit/env.ts";
import { FireLog } from "../../../hooks/lib/hookkit/fires.ts";
import { readTsv } from "../../../hooks/lib/hookkit/overlay.ts";
import * as protocol from "../../../hooks/lib/hookkit/protocol.ts";
import type { Payload } from "../../../hooks/lib/hookkit/protocol.ts";
import { getField, isTruthy, joinPath, normalizePath, expandUser, partition, pythonStr, strip, arraysEqual, PY_SPACE, testCaseFolded } from "../../../hooks/lib/hookkit/pycompat.ts";
import { globMatches } from "../../../lib/evidence/glob.ts";
import { parsePayload } from "../../../hooks/lib/hookkit/json.ts";
import { isDirectory } from "../../../hooks/lib/hookkit/files.ts";
import { describeError, ValueError } from "../../../hooks/lib/hookkit/errors.ts";
import { readStdin } from "../../../hooks/lib/hookkit/stdio.ts";
import { findRepoKey, findSuperproject, findToplevel } from "../../../hooks/lib/hookkit/repo.ts";
import { parseCommands, unwrap } from "../../../hooks/lib/hookkit/shell.ts";
import type { Invocation, SimpleCommand } from "../../../hooks/lib/hookkit/shell.ts";

const HOOK = "env-preflight";
const RULE = "S-jdk";
const JDK_MAP_HEADER = ["origin_glob", "jdk"] as const;
const MAVEN_COMMANDS: ReadonlySet<string> = new Set(["mvn", "mvnw"]);
const VERSION_QUERY_FLAGS: ReadonlySet<string> = new Set(["-v", "--version", "-version"]);
const EXPORT_COMMANDS: ReadonlySet<string> = new Set(["export", "declare", "typeset"]);
const JAVA_HOME = "JAVA_HOME";
const VARIABLE_REFERENCE_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const JDK_VENDOR_WORDS = "(?:jdk|java|temurin|zulu|corretto|openjdk)";
const SYNTAX_CHARACTERS = /[\\^$.*+?()[\]{}|/]/g;

class ShellState {
  javaHome: string | null = null;
  exported = false;
  variables = new Map<string, string>();

  clone(): ShellState {
    const copy = new ShellState();
    copy.javaHome = this.javaHome;
    copy.exported = this.exported;
    copy.variables = new Map(this.variables);
    return copy;
  }

  apply(command: SimpleCommand): void {
    const invocation = unwrap(command);
    if (invocation.argv.length === 0) {
      for (const [name, value] of command.assignments) this.variables.set(name, value);
      const assigned = command.assignments.filter(([name]) => name === JAVA_HOME).pop();
      if (assigned) this.javaHome = assigned[1];
      return;
    }
    const name = invocation.name;
    const args = invocation.argv.slice(1);
    if (EXPORT_COMMANDS.has(name)) {
      this.applyExport(name, args);
    } else if (name === "unset" && args.includes(JAVA_HOME)) {
      this.javaHome = null;
      this.exported = false;
    }
  }

  private applyExport(name: string, args: string[]): void {
    if (name !== "export" && !args.includes("-x")) return;
    if (args.includes("-n") && args.includes(JAVA_HOME)) {
      this.exported = false;
      return;
    }
    for (const arg of args) {
      const [variable, separator, value] = partition(arg, "=");
      if (variable !== JAVA_HOME) continue;
      this.exported = true;
      if (separator !== "") this.javaHome = value;
    }
  }

  resolve(value: string): string {
    const reference = VARIABLE_REFERENCE_RE.exec(value);
    return reference ? (this.variables.get(reference[1] ?? "") ?? value) : value;
  }
}

interface MavenBuild {
  command: SimpleCommand;
  invocation: Invocation;
  state: ShellState;
  directory: string;
  isFirst: boolean;
}

function main(): number {
  let payload: Payload;
  try {
    payload = parsePayload(readStdin());
  } catch (error) {
    if (error instanceof ValueError) return protocol.EXIT_PASS;
    throw error;
  }
  const fires = new FireLog(HOOK, getField(payload, "session_id") as string | null);
  try {
    return checkMavenJdk(payload, fires);
  } catch (error) {
    fires.append(RULE, "error", { detail: describeError(error) });
    return protocol.EXIT_PASS;
  }
}

function checkMavenJdk(payload: Payload, fires: FireLog): number {
  const command = getField(protocol.toolInput(payload), "command");
  const commandLine = pythonStr(isTruthy(command) ? command : "");
  if (protocol.toolName(payload) !== "bash" || !commandLine.includes("mvn")) return protocol.EXIT_PASS;
  const cwd = pythonStr(isTruthy(getField(payload, "cwd")) ? getField(payload, "cwd") : process.cwd());
  const builds = findMavenBuilds(parseCommands(commandLine), cwd);
  for (const build of builds) {
    const required = requiredJdk(build.directory);
    if (required === null) continue;
    const [repoKey, major] = required;
    if (!pinsJdk(build, major)) {
      fires.append(RULE, "deny", { repo: repoKey, detail: `mvn without JDK ${major}` });
      const retry = retryCommand(commandLine, build, major, cwd);
      return protocol.deny(denyMessage(build, major, repoKey, retry));
    }
    fires.append(RULE, "pass", { repo: repoKey });
  }
  return protocol.EXIT_PASS;
}

function findMavenBuilds(commands: readonly SimpleCommand[], cwd: string): MavenBuild[] {
  const builds: MavenBuild[] = [];
  const state = new ShellState();
  let directory = cwd;
  let topLevelIndex = 0;
  for (const command of commands) {
    const invocation = unwrap(command);
    const isBuild = MAVEN_COMMANDS.has(invocation.name) && !VERSION_QUERY_FLAGS.has(invocation.argv[1] ?? "");
    if (isBuild && !invocation.movesDirectory) {
      builds.push({
        command, invocation, state: state.clone(), directory: command.nested ? cwd : directory,
        isFirst: !command.nested && topLevelIndex === 0,
      });
    }
    if (command.nested) continue;
    state.apply(command);
    if (invocation.name === "cd" && invocation.argv.length > 1) {
      directory = normalizePath(joinPath(directory, expandUser(invocation.argv[1] ?? "")));
    }
    topLevelIndex += 1;
  }
  return builds;
}

function requiredJdk(directory: string): readonly [repoKey: string, major: string] | null {
  if (!isDirectory(directory)) return null;
  const toplevel = findToplevel(directory);
  if (toplevel === null) return null;
  const rows = readTsv(overlayPath("stack-data", "spring-maven", "jdk.tsv"), JDK_MAP_HEADER);
  if (rows.length === 0) return null;
  const superproject = findSuperproject(toplevel);
  for (const candidate of [toplevel, superproject]) {
    const key = candidate ? findRepoKey(candidate) : null;
    for (const row of rows) {
      if (key && globMatches(key, row["origin_glob"] ?? "")) return [key, row["jdk"] ?? ""];
    }
  }
  return null;
}

function pinsJdk(build: MavenBuild, major: string): boolean {
  const own = build.invocation.assignments.filter(([name]) => name === JAVA_HOME);
  const last = own[own.length - 1];
  if (last) return namesJdk(build.state.resolve(last[1]), major);
  if (build.invocation.dropsInherited(JAVA_HOME)) return false;
  return build.state.exported && build.state.javaHome !== null && namesJdk(build.state.resolve(build.state.javaHome), major);
}

function namesJdk(value: string, major: string): boolean {
  const escaped = major.replace(SYNTAX_CHARACTERS, "\\$&");
  const space = `[${PY_SPACE}]`;
  const lookup = new RegExp(`java_home${space}+(?:-v${space}*|--version[${PY_SPACE}=]+)${escaped}(?:\\.[0-9]+)*(?![0-9.+*])`, "u");
  const path = new RegExp(`${JDK_VENDOR_WORDS}[-_.@/]?${escaped}(?![0-9])`, "iu");
  return lookup.test(value) || testCaseFolded(path, value);
}

function retryCommand(commandLine: string, build: MavenBuild, major: string, cwd: string): string | null {
  const pin = javaHomePin(major);
  const line = strip(commandLine);
  const candidates = [`${JAVA_HOME}=${pin} ${line}`, `export ${JAVA_HOME}=${pin}; ${line}`];
  for (const [name, value] of build.invocation.assignments) {
    if (name === JAVA_HOME) candidates.push(line.replace(`${JAVA_HOME}=${value}`, () => `${JAVA_HOME}=${pin}`));
  }
  for (const candidate of candidates) {
    const builds = findMavenBuilds(parseCommands(candidate), cwd);
    if (builds.length > 0 && builds.every((rebuilt) => pinsJdk(rebuilt, major))) return candidate;
  }
  return null;
}

function denyMessage(build: MavenBuild, major: string, repoKey: string, retry: string | null): string {
  const pin = javaHomePin(major);
  const hasOwnAssignment = build.invocation.assignments.some(([name]) => name === JAVA_HOME);
  let hint: string;
  if (hasOwnAssignment) {
    hint = `The JAVA_HOME on the mvn command is not JDK ${major}; replace its value with ${pin}.`;
  } else if (build.invocation.dropsInherited(JAVA_HOME)) {
    hint = "This wrapper drops the inherited environment, so an export never reaches mvn; put " +
      `JAVA_HOME=${pin} after the wrapper's options (env -i also drops PATH, keep it).`;
  } else if (build.isFirst && build.command.assignments.length === 0 && arraysEqual(build.invocation.argv, build.command.argv)) {
    hint = `Put JAVA_HOME=${pin} in front of the command.`;
  } else {
    hint = `Put JAVA_HOME=${pin} right before mvn (an assignment at the start of the line only reaches the first command).`;
  }
  return protocol.formatMessage(
    HOOK, `mvn in ${repoKey} must run on JDK ${major}`,
    [[RULE, `Pin JAVA_HOME to JDK ${major} on this command. ${hint}`]],
    retry ? protocol.runYourself(retry) : protocol.ASK_USER,
  );
}

function javaHomePin(major: string): string {
  return process.platform === "darwin" ? `$(/usr/libexec/java_home -v ${major})` : `<path to JDK ${major}>`;
}

if (import.meta.main) process.exitCode = main();
