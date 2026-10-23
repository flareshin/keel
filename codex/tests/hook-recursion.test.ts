import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recordedAnswers } from "../../tests/recorded.ts";
import { withoutLocale } from "./locale-env.ts";

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
    const env = { ...withoutLocale(process.env), HOME: root, KEEL_CODEX_HOME: profile, KEEL_AGENTS_HOME: join(root, "agents"), KEEL_DATA_DIR: join(root, "data"), KEEL_OVERLAY_DIR: join(root, "overlay") };
    return spawnSync(command[0] as string, command.slice(1), { input: JSON.stringify(payload), env, encoding: "utf8" }).status;
  }

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`crashes on ${name} at exactly the depth where the Python hook did`, () => {
      const [low] = recordedAnswers<unknown, [number]>("codex-hook-recursion", [{ crashDepth: name }])[0] as [number];
      console.log(`parity hook deep ${name}: python first crashes at depth ${low}`);
      assert.equal(hookStatus(shape(low - 1)), 0);
      assert.equal(hookStatus(shape(low)), 1);
    });
  }

  it("cleans up", () => rmSync(root, { recursive: true, force: true }));
});
