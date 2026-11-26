import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { KEEL_HOME } from "./helpers.ts";
import { iterRegistrations } from "../../measure/lib/measurekit/hook_settings.ts";

const REGISTRATION_FILES = ["hooks/hooks.json", "settings/core.json", "stacks/spring-maven/settings.json"];
const TILDE_DATA_DIR = "~/keel-data";
const COMMAND_TIMEOUT_MS = 60_000;

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keel-registered-cache-"));
  home = join(root, "home");
  cwd = join(root, "work");
  mkdirSync(home);
  mkdirSync(cwd);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function registeredCommands(file: string): string[] {
  const settings = JSON.parse(readFileSync(join(KEEL_HOME, file), "utf8"));
  return [...new Set(iterRegistrations(settings.hooks).map((registration) => registration.command.replaceAll("{{KEEL}}", KEEL_HOME)))];
}

function runAsRegistered(command: string): void {
  const { NODE_COMPILE_CACHE: _cache, NODE_TEST_CONTEXT: _runner, ...env } = process.env;
  const completed = spawnSync("sh", ["-c", command], {
    cwd, input: "{}", encoding: "utf8", timeout: COMMAND_TIMEOUT_MS,
    env: { ...env, HOME: home, KEEL_DATA_DIR: TILDE_DATA_DIR, CLAUDE_PLUGIN_ROOT: KEEL_HOME },
  });
  assert.equal(completed.error, undefined, `${command}: ${completed.error}`);
}

describe("RegisteredCompileCacheTest", () => {
  for (const file of REGISTRATION_FILES) {
    it(`everyCommandIn_${file}_putsTheCompileCacheUnderTheExpandedDataDir_whenKeelDataDirStartsWithATilde`, () => {
      const commands = registeredCommands(file);
      assert.ok(commands.length > 0, `${file} registers no command`);
      for (const command of commands) {
        runAsRegistered(command);
        assert.equal(existsSync(join(cwd, "~")), false, `${command} made a literal ~ directory in its working directory`);
        const cache = join(home, "keel-data", "state", "keel", "node-compile-cache");
        assert.ok(existsSync(cache) && readdirSync(cache).length > 0, `${command} wrote no compile cache under ${cache}`);
        rmSync(cache, { recursive: true, force: true });
      }
    });
  }
});
