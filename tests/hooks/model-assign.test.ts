import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { assertBulletIdsSeeded, assertFired, HookSandbox, MODEL_ASSIGN, preToolUse } from "./helpers.ts";
import type { HookResult } from "./helpers.ts";

let sandbox: HookSandbox;

beforeEach(() => {
  sandbox = new HookSandbox();
});

afterEach(() => {
  sandbox.close();
});

function dispatch(toolInput: Record<string, unknown> = {}): HookResult {
  const input = { description: "Find callers", prompt: "Find every caller of parse().", ...toolInput };
  return sandbox.runHook(MODEL_ASSIGN, { payload: preToolUse("Agent", input, sandbox.root) });
}

function workflow(toolInput: Record<string, unknown>): HookResult {
  return sandbox.runHook(MODEL_ASSIGN, { payload: preToolUse("Workflow", toolInput, sandbox.root) });
}

function updated(result: HookResult): Record<string, unknown> {
  return result.json().hookSpecificOutput.updatedInput;
}

describe("AgentDispatchTest", () => {
  it("dispatch_getsSonnetAndMedium_whenModelAndEffortOmitted", () => {
    const result = dispatch();
    assert.deepEqual([updated(result)["model"], updated(result)["effort"]], ["sonnet", "medium"]);
    assert.equal(updated(result)["prompt"], "Find every caller of parse().");
    assertFired(sandbox, "C-dispatch", "record", "model-assign");
  });

  it("dispatch_getsOpusAndHigh_whenBriefAsksForVerdict", () => {
    const result = dispatch({ prompt: "Review the diff and return a VERDICT line." });
    assert.deepEqual([updated(result)["model"], updated(result)["effort"]], ["opus", "high"]);
  });

  it("dispatch_getsHaiku_whenReadOnlyExploreType", () => {
    assert.equal(updated(dispatch({ subagent_type: "Explore" }))["model"], "haiku");
  });

  it("dispatch_keepsHaiku_whenExploreNamesIt", () => {
    assert.equal(updated(dispatch({ subagent_type: "Explore", model: "haiku" }))["model"], "haiku");
  });

  it("dispatch_raisesHaikuToSonnet_whenTypeCanEdit", () => {
    assert.equal(updated(dispatch({ model: "haiku", effort: "low" }))["model"], "sonnet");
  });

  it("dispatch_capsFableToOpus_whenAgentDispatch", () => {
    assert.equal(updated(dispatch({ model: "fable", effort: "high" }))["model"], "opus");
  });

  it("dispatch_passesUntouched_whenModelAndEffortInBand", () => {
    const result = dispatch({ model: "sonnet", effort: "low" });
    assert.equal(result.stdout, "");
    assertFired(sandbox, "C-dispatch", "pass", "model-assign");
  });

  it("dispatch_passesUntouched_whenFork", () => {
    assert.equal(dispatch({ subagent_type: "fork" }).stdout, "");
  });

  it("dispatch_keepsEffortUnset_whenAgentFilePinsEffort", () => {
    sandbox.write(join(sandbox.data, "agents", "worker-pinned.md"), "---\nname: worker-pinned\neffort: low\n---\nBody\n");
    const result = dispatch({ subagent_type: "worker-pinned", model: "sonnet" });
    assert.equal(result.stdout, "");
  });

  it("dispatch_keepsEffortUnset_whenAgentFileWithCrlfLineEndsPinsEffort", () => {
    sandbox.write(join(sandbox.data, "agents", "worker-pinned.md"), "---\r\nname: worker-pinned\r\neffort: low\r\n---\r\nBody\r\n");
    const result = dispatch({ subagent_type: "worker-pinned", model: "sonnet" });
    assert.equal(result.stdout, "");
  });

  it("dispatch_setsEffort_whenAgentFileHasNoPin", () => {
    sandbox.write(join(sandbox.data, "agents", "worker-plain.md"), "---\nname: worker-plain\n---\neffort: in body only\n");
    assert.equal(updated(dispatch({ subagent_type: "worker-plain", model: "sonnet" }))["effort"], "medium");
  });
});

describe("WorkflowScriptTest", () => {
  it("workflow_deniedWithCDispatch_whenAgentCallsNameNoModel", () => {
    const result = workflow({ script: "await agent('probe', {effort: 'medium'})" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /opts\.model/);
    assertBulletIdsSeeded(result.stderr);
    assertFired(sandbox, "C-dispatch", "deny", "model-assign");
  });

  it("workflow_passes_whenModelAndEffortPresent", () => {
    const result = workflow({ script: "await agent('probe', {\"model\": 'haiku', effort: 'medium'})" });
    assert.equal(result.code, 0);
    assertFired(sandbox, "C-dispatch", "pass", "model-assign");
  });

  it("workflow_readsScriptPath_whenGiven", () => {
    const path = sandbox.write(join(sandbox.root, "wf.js"), "await agent('x', {model: 'opus'})\n");
    const result = workflow({ scriptPath: path });
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes(path), result.stderr);
  });

  it("workflow_passes_whenResuming", () => {
    assert.equal(workflow({ script: "agent('x')", resumeFromRunId: "run-1" }).code, 0);
  });

  it("workflow_passes_whenNamedWorkflowHasNoScript", () => {
    assert.equal(workflow({ name: "lens-review" }).code, 0);
  });
});

describe("FailureTest", () => {
  it("modelAssign_passes_whenPayloadIsNotJson", () => {
    assert.equal(sandbox.runHook(MODEL_ASSIGN, { raw: "{" }).code, 0);
  });

  it("modelAssign_passesAndLogsError_whenScriptPathUnreadable", () => {
    const path = join(sandbox.root, "unreadable.js");
    sandbox.write(path, "agent(");
    chmodSync(path, 0);
    const result = workflow({ scriptPath: path });
    assert.equal(result.code, 0);
    const [fire] = assertFired(sandbox, "C-dispatch", "error", "model-assign");
    assert.match(fire?.detail ?? "", /^Error: EACCES: permission denied, open '.*unreadable\.js'$/);
  });

  it("modelAssign_ignoresOtherTools", () => {
    const result = sandbox.runHook(MODEL_ASSIGN, { payload: preToolUse("Bash", { command: "ls" }, sandbox.root) });
    assert.deepEqual([result.stdout, sandbox.fires()], ["", []]);
  });
});
