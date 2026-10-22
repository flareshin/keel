import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const MAX_DEPTH = 700;
const SHAPES: Record<string, (depth: number) => string> = {
  arrays: (depth) => `a = ${"[".repeat(depth)}${"]".repeat(depth)}\n`,
  "inline tables": (depth) => `a = ${"{a=".repeat(depth)}1${"}".repeat(depth)}\n`,
  "arrays of inline tables": (depth) => `a = ${"[{a=".repeat(depth)}1${"}]".repeat(depth)}\n`,
};

describe("pre-tool-use hook crash depth on deeply nested config TOML", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-hook-recursion-")));
  const profile = join(root, "profile");
  mkdirSync(profile);

  function hookStatus(implementation: "python" | "typescript", content: string): number | null {
    const payload = { tool_name: "Write", tool_input: { file_path: join(profile, "config.toml"), content }, cwd: root };
    const command = implementation === "python" ? ["python3", join(HOOKS, "pre-tool-use.py")] : [process.execPath, join(HOOKS, "pre-tool-use.ts")];
    const env = { ...process.env, HOME: root, KEEL_CODEX_HOME: profile, KEEL_AGENTS_HOME: join(root, "agents"), KEEL_DATA_DIR: join(root, "data"), KEEL_OVERLAY_DIR: join(root, "overlay") };
    return spawnSync(command[0] as string, command.slice(1), { input: JSON.stringify(payload), env, encoding: "utf8" }).status;
  }

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`crashes on ${name} at exactly the depth where the Python hook does`, () => {
      let low = 1;
      let high = MAX_DEPTH;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (hookStatus("python", shape(middle)) === 0) low = middle + 1;
        else high = middle;
      }
      console.log(`parity hook deep ${name}: python first crashes at depth ${low}`);
      assert.equal(hookStatus("python", shape(low - 1)), 0);
      assert.equal(hookStatus("python", shape(low)), 1);
      assert.equal(hookStatus("typescript", shape(low - 1)), 0);
      assert.equal(hookStatus("typescript", shape(low)), 1);
    });
  }

  it("cleans up", () => rmSync(root, { recursive: true, force: true }));
});
