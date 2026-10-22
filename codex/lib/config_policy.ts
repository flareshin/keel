import { expandUser, isTruthy } from "../../hooks/lib/hookkit/pycompat.ts";
import { ExitRequest, parseArguments } from "./argparse.ts";
import type { CommandParser } from "./argparse.ts";
import type { CommandResult } from "./command.ts";
import { writeAtomic } from "./files.ts";
import { pythonFailureMessage, ValueError } from "./pyerrors.ts";
import { childPath, pathExists, purePath, readText, resolvePath } from "./pyfs.ts";
import { tomlEquals, tomlLoads } from "./toml.ts";

const REFUSED_EXIT_CODE = 3;
export const CONFIG_COMMAND_CALLER_FRAMES = 3;
export const HOOK_CALLER_FRAMES = 4;

const CONFIG_PARSER: CommandParser = {
  prog: "config",
  usage: "usage: config [-h] --file FILE [--profile PROFILE]\n",
  help: [
    "usage: config [-h] --file FILE [--profile PROFILE]",
    "",
    "Validate and replace Codex config without changing hook policy.",
    "",
    "options:",
    "  -h, --help         show this help message and exit",
    "  --file FILE        complete proposed config.toml",
    "  --profile PROFILE",
    "",
  ].join("\n"),
  options: [
    { flags: ["--file"], dest: "file", takesValue: true, required: true },
    { flags: ["--profile"], dest: "profile", takesValue: true },
  ],
};

function defaultProfile(): string {
  return process.env["CODEX_HOME"] ?? childPath(expandUser("~"), ".codex");
}

export function main(argv: readonly string[]): CommandResult {
  let parsed: Map<string, string | true>;
  try {
    parsed = parseArguments(CONFIG_PARSER, argv);
  } catch (error) {
    if (error instanceof ExitRequest) return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    throw error;
  }
  try {
    const profile = (parsed.get("profile") as string | undefined) ?? defaultProfile();
    const path = resolvePath(childPath(expandUser(purePath(profile)), "config.toml"));
    const candidate = readText(purePath(parsed.get("file") as string));
    validateUpdate(pathExists(path) ? readText(path) : "", candidate);
    writeAtomic(path, candidate);
    return { code: 0, stdout: `Updated ${path}; hook configuration preserved.\n`, stderr: "" };
  } catch (error) {
    const message = pythonFailureMessage(error);
    if (message === null) throw error;
    return { code: REFUSED_EXIT_CODE, stdout: "", stderr: `codex/config: refused: ${message}\n` };
  }
}

export function validateUpdate(current: string, candidate: string, callerFrames: number = CONFIG_COMMAND_CALLER_FRAMES): void {
  const before = tomlLoads(current, callerFrames);
  const after = tomlLoads(candidate, callerFrames);
  const features = after.get("features") ?? new Map();
  if (!(features instanceof Map)) throw new ValueError("features must be a TOML table");
  if (features.has("hooks") && features.get("hooks") !== true) throw new ValueError("F-hookskip: features.hooks must remain enabled");
  if ((after.get("allow_managed_hooks_only") ?? false) !== false) throw new ValueError("F-hookskip: user hooks must remain enabled");
  if (!tomlEquals(before.get("hooks") ?? new Map(), after.get("hooks") ?? new Map())) {
    throw new ValueError("hook configuration must be changed by the owner, outside agent tools");
  }
}

export function completeEdit(path: string, tool: Record<string, unknown>): string {
  if (isTruthy(tool["keel_partial"])) {
    throw new ValueError("partial config patches cannot be verified; use codex/bin/config --file <complete TOML>");
  }
  if (typeof tool["content"] === "string") return tool["content"];
  const current = readText(path);
  const old = tool["old_string"];
  const replacement = tool["new_string"];
  if (typeof old !== "string" || old === "" || typeof replacement !== "string") {
    throw new ValueError("a complete config write or exact replacement is required");
  }
  const count = current.split(old).length - 1;
  const replaceAll = isTruthy(tool["replace_all"]);
  if (count === 0 || (count !== 1 && !replaceAll)) throw new ValueError("config replacement does not identify an unambiguous result");
  if (replaceAll) return current.split(old).join(replacement);
  const at = current.indexOf(old);
  return current.slice(0, at) + replacement + current.slice(at + old.length);
}
