import { expandUser } from "../../hooks/lib/hookkit/pycompat.ts";
import { parseCommandLine, noPositionals, usageError } from "../../measure/lib/measurekit/cli.ts";
import type { CommandSpec } from "../../measure/lib/measurekit/cli.ts";
import { isCommandResult, parseOrExit } from "./command.ts";
import type { CommandResult } from "./command.ts";
import { readText, writeAtomic } from "./files.ts";
import { isTruthy } from "./json.ts";
import { childPath, cleanPath, pathExists, resolvePath } from "./paths.ts";
import { Refusal, refusalMessage } from "./refusal.ts";
import { tomlEquals, tomlLoads } from "./toml.ts";

const REFUSED_EXIT_CODE = 3;
export const CONFIG_COMMAND_CALLER_FRAMES = 3;
export const HOOK_CALLER_FRAMES = 4;

const CONFIG_COMMAND: CommandSpec = {
  prog: "config",
  usage: "config [-h] --file FILE [--profile PROFILE]",
  description: "Validate and replace Codex config without changing hook policy.",
  argumentHelp: [["--file FILE", "complete proposed config.toml"], ["--profile PROFILE", "Codex profile directory"]],
  options: { file: { type: "string" }, profile: { type: "string" } },
};

function defaultProfile(): string {
  return process.env["CODEX_HOME"] ?? childPath(expandUser("~"), ".codex");
}

export function main(argv: readonly string[]): CommandResult {
  const options = parseOrExit(() => {
    const parsed = parseCommandLine(CONFIG_COMMAND, [...argv]);
    noPositionals(CONFIG_COMMAND, parsed);
    const file = parsed.values["file"];
    if (typeof file !== "string") usageError(CONFIG_COMMAND, "the following arguments are required: --file");
    const profile = parsed.values["profile"];
    return { file, profile: typeof profile === "string" ? profile : defaultProfile() };
  });
  if (isCommandResult(options)) return options;
  try {
    const path = resolvePath(childPath(expandUser(cleanPath(options.profile)), "config.toml"));
    const candidate = readText(cleanPath(options.file));
    validateUpdate(pathExists(path) ? readText(path) : "", candidate);
    writeAtomic(path, candidate);
    return { code: 0, stdout: `Updated ${path}; hook configuration preserved.\n`, stderr: "" };
  } catch (error) {
    const message = refusalMessage(error);
    if (message === null) throw error;
    return { code: REFUSED_EXIT_CODE, stdout: "", stderr: `codex/config: refused: ${message}\n` };
  }
}

export function validateUpdate(current: string, candidate: string, callerFrames: number = CONFIG_COMMAND_CALLER_FRAMES): void {
  const before = tomlLoads(current, callerFrames);
  const after = tomlLoads(candidate, callerFrames);
  const features = after.get("features") ?? new Map();
  if (!(features instanceof Map)) throw new Refusal("features must be a TOML table");
  if (features.has("hooks") && features.get("hooks") !== true) throw new Refusal("F-hookskip: features.hooks must remain enabled");
  if ((after.get("allow_managed_hooks_only") ?? false) !== false) throw new Refusal("F-hookskip: user hooks must remain enabled");
  if (!tomlEquals(before.get("hooks") ?? new Map(), after.get("hooks") ?? new Map())) {
    throw new Refusal("hook configuration must be changed by the owner, outside agent tools");
  }
}

export function completeEdit(path: string, tool: Record<string, unknown>): string {
  if (isTruthy(tool["keel_partial"])) {
    throw new Refusal("partial config patches cannot be verified; use codex/bin/config --file <complete TOML>");
  }
  if (typeof tool["content"] === "string") return tool["content"];
  const current = readText(path);
  const old = tool["old_string"];
  const replacement = tool["new_string"];
  if (typeof old !== "string" || old === "" || typeof replacement !== "string") {
    throw new Refusal("a complete config write or exact replacement is required");
  }
  const count = current.split(old).length - 1;
  const replaceAll = isTruthy(tool["replace_all"]);
  if (count === 0 || (count !== 1 && !replaceAll)) throw new Refusal("config replacement does not identify an unambiguous result");
  if (replaceAll) return current.split(old).join(replacement);
  const at = current.indexOf(old);
  return current.slice(0, at) + replacement + current.slice(at + old.length);
}
