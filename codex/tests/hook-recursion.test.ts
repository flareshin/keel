import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SHALLOW_DEPTH = 10;
const PAST_THE_LIMIT_DEPTH = 2000;
const HOOKS = join(import.meta.dirname, "..", "hooks");
const SHAPES: Record<string, (depth: number) => string> = {
  arrays: (depth) => `a = ${"[".repeat(depth)}${"]".repeat(depth)}\n`,
  "inline tables": (depth) => `a = ${"{a=".repeat(depth)}1${"}".repeat(depth)}\n`,
  "arrays of inline tables": (depth) => `a = ${"[{a=".repeat(depth)}1${"}]".repeat(depth)}\n`,
};

describe("pre-tool-use hook crash depth on deeply nested config TOML", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-hook-recursion-")));
  const profile = join(root, "profile");
  mkdirSync(profile);

  function hookStatus(content: string): number | null {
    const payload = { tool_name: "Write", tool_input: { file_path: join(profile, "config.toml"), content }, cwd: root };
    const command = [process.execPath, join(HOOKS, "pre-tool-use.ts")];
    const env = { ...process.env, HOME: root, KEEL_CODEX_HOME: profile, KEEL_AGENTS_HOME: join(root, "agents"), KEEL_DATA_DIR: join(root, "data"), KEEL_OVERLAY_DIR: join(root, "overlay") };
    return spawnSync(command[0] as string, command.slice(1), { input: JSON.stringify(payload), env, encoding: "utf8" }).status;
  }

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`passes ${name} ${SHALLOW_DEPTH} deep and crashes on ${PAST_THE_LIMIT_DEPTH} deep`, () => {
      assert.equal(hookStatus(shape(SHALLOW_DEPTH)), 0);
      assert.equal(hookStatus(shape(PAST_THE_LIMIT_DEPTH)), 1);
    });
  }

  it("cleans up", () => rmSync(root, { recursive: true, force: true }));
});
