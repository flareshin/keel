import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { completeEdit } from "../lib/config_policy.ts";
import { Refusal } from "../lib/refusal.ts";
import { protectAdapter } from "../hooks/pre-tool-use.ts";
import type { Call } from "../hooks/pre-tool-use.ts";

const ANY_FLAG_VALUE_THAT_IS_NOT_A_BOOLEAN: Array<[string, unknown]> = [
  ["string", "yes"], ["empty string", ""], ["object", { k: 1 }], ["empty object", {}], ["number", 1], ["zero", 0], ["list", [1]], ["empty list", []],
];
const CWD_THAT_IS_NOT_TEXT: Array<[string, unknown]> = [
  ["object", { k: "v" }], ["empty object", {}], ["list", ["x"]], ["empty list", []], ["number", 5], ["zero", 0], ["true", true], ["false", false],
];

function withConfig<T>(content: string, body: (config: string) => T): T {
  const profile = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-codex-wrong-types-")));
  try {
    const config = join(profile, "config.toml");
    writeFileSync(config, content);
    return body(config);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("completeEdit with a flag that is not a boolean", () => {
  for (const [label, flag] of ANY_FLAG_VALUE_THAT_IS_NOT_A_BOOLEAN) {
    it(`refuses_aPartialPatch_whenKeelPartialIs_${label.replace(" ", "_")}`, () => {
      withConfig("[features]\nhooks = true\n", (config) => {
        assert.throws(() => completeEdit(config, { keel_partial: flag, content: 'model = "x"' }), (error: unknown) => error instanceof Refusal && /^partial config patches cannot be verified/.test(error.message));
      });
    });

    it(`replacesOnlyAUniqueMatch_whenReplaceAllIs_${label.replace(" ", "_")}`, () => {
      withConfig("[features]\nhooks = true\nx = true\n", (config) => {
        assert.throws(() => completeEdit(config, { old_string: "true", new_string: "false", replace_all: flag }), (error: unknown) => error instanceof Refusal && error.message === "config replacement does not identify an unambiguous result");
      });
    });
  }

  it("treatsAbsentNullAndFalseKeelPartialAsNotPartial_andRefusesTrue", () => {
    withConfig("[features]\nhooks = true\n", (config) => {
      for (const tool of [{}, { keel_partial: null }, { keel_partial: false }]) assert.equal(completeEdit(config, { ...tool, content: "x" }), "x");
      assert.throws(() => completeEdit(config, { keel_partial: true, content: "x" }), Refusal);
    });
  });

  it("replacesEveryMatch_onlyWhenReplaceAllIsTrue", () => {
    withConfig("[features]\nhooks = true\nx = true\n", (config) => {
      assert.equal(completeEdit(config, { old_string: "true", new_string: "false", replace_all: true }), "[features]\nhooks = false\nx = false\n");
      for (const replaceAll of [undefined, null, false]) {
        assert.throws(() => completeEdit(config, { old_string: "true", new_string: "false", replace_all: replaceAll }), Refusal);
      }
    });
  });
});

describe("protectAdapter with a cwd that is not text", () => {
  const call = (cwd: unknown): Call => ({ tool_name: "Bash", tool_input: { command: "git status" }, hook_event_name: "PreToolUse", cwd, session_id: "codex-test" });

  for (const [label, cwd] of CWD_THAT_IS_NOT_TEXT) {
    it(`refuses_whenCwdIs_${label.replace(" ", "_")}`, () => {
      assert.throws(() => protectAdapter(call(cwd)), (error: unknown) => error instanceof Refusal && error.message === "cwd must be a string");
    });
  }

  it("readsAMissingNullOrEmptyCwdAsTheProcessDirectory", () => {
    for (const cwd of [undefined, null, ""]) assert.doesNotThrow(() => protectAdapter(call(cwd)));
  });
});
