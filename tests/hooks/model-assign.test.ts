import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { assertBulletIdsSeeded, assertFired, HookSandbox, MODEL_ASSIGN, preToolUse } from "./helpers.ts";
import type { HookResult } from "./helpers.ts";
import { MAX_JSON_DEPTH } from "../../measure/lib/measurekit/json.ts";

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

  it("dispatch_keepsEffortUnset_whenKeelPluginAgentFilePinsEffort", () => {
    const pluginRoot = join(sandbox.root, "plugin");
    sandbox.env["KEEL_HOME"] = pluginRoot;
    sandbox.write(join(pluginRoot, "agents", "worker-pinned.md"), "---\nname: worker-pinned\neffort: low\n---\nBody\n");
    const result = dispatch({ subagent_type: "keel:worker-pinned", model: "sonnet" });
    assert.equal(result.stdout, "");
  });

  it("dispatch_assignsEffort_whenAnotherPluginNamesAnAgentFileOnlyKeelShips", () => {
    const pluginRoot = join(sandbox.root, "plugin");
    sandbox.env["KEEL_HOME"] = pluginRoot;
    sandbox.write(join(pluginRoot, "agents", "worker-pinned.md"), "---\nname: worker-pinned\neffort: low\n---\nBody\n");
    const result = dispatch({ subagent_type: "acme:worker-pinned", model: "sonnet" });
    assert.equal(updated(result)["effort"], "medium");
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

  it("dispatch_keepsModelUnset_whenReadOnlyAgentFilePinsHaiku", () => {
    sandbox.write(join(sandbox.data, "agents", "log-reader.md"), "---\nname: log-reader\ntools: Read, Grep, Glob, Bash\nmodel: haiku\n---\nBody\n");
    const result = updated(dispatch({ subagent_type: "log-reader" }));
    assert.deepEqual([result["model"], result["effort"]], [undefined, "medium"]);
  });

  it("dispatch_keepsModelUnset_whenAgentFilePinsSonnet", () => {
    sandbox.write(join(sandbox.data, "agents", "worker-sonnet.md"), "---\nname: worker-sonnet\nmodel: sonnet\neffort: low\n---\nBody\n");
    assert.equal(dispatch({ subagent_type: "worker-sonnet" }).stdout, "");
  });

  for (const tools of ["Read, Edit, Bash", "Read, MultiEdit", "Write", "Bash, NotebookEdit", "Read, Edit(*)", "Read Edit", "\"Read, Edit\"", "[Read, Edit]", ""]) {
    it(`dispatch_raisesPinnedHaikuToSonnet_whenAgentFileToolsAre_${tools || "empty"}`, () => {
      sandbox.write(join(sandbox.data, "agents", "fixer.md"), `---\nname: fixer\ntools: ${tools}\nmodel: haiku\n---\nBody\n`);
      assert.equal(updated(dispatch({ subagent_type: "fixer" }))["model"], "sonnet");
    });
  }

  it("dispatch_keepsModelUnset_whenAgentFilePinsHaikuAndScopesBashOnly", () => {
    sandbox.write(join(sandbox.data, "agents", "git-reader.md"), "---\nname: git-reader\ntools: Read, Bash(git log:*)\nmodel: haiku\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "git-reader" }))["model"], undefined);
  });

  it("dispatch_getsOpus_whenAgentFilePinsSonnetButBriefAsksForVerdict", () => {
    sandbox.write(join(sandbox.data, "agents", "reader.md"), "---\nname: reader\ntools: Read, Grep\nmodel: sonnet\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "reader", prompt: "Return a VERDICT line." }))["model"], "opus");
  });

  it("dispatch_keepsModelUnset_whenAgentFilePinsOpusAndBriefAsksForVerdict", () => {
    sandbox.write(join(sandbox.data, "agents", "judge.md"), "---\nname: judge\nmodel: opus\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "judge", prompt: "Return a VERDICT line." }))["model"], undefined);
  });

  it("dispatch_keepsModelUnset_whenAgentFilePinsAModelWithNoTier", () => {
    sandbox.write(join(sandbox.data, "agents", "inheritor.md"), "---\nname: inheritor\ntools: Read, Grep\nmodel: inherit\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "inheritor" }))["model"], undefined);
  });

  it("dispatch_getsSonnet_whenUnpinnedAgentFileListsOnlyReadTools", () => {
    sandbox.write(join(sandbox.data, "agents", "auditor.md"), "---\nname: auditor\ntools: Bash, Read, Skill\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "auditor" }))["model"], "sonnet");
  });

  it("dispatch_raisesNamedHaikuToSonnet_whenReadOnlyAgentFilePinsAModel", () => {
    sandbox.write(join(sandbox.data, "agents", "reader.md"), "---\nname: reader\ntools: Read, Grep\nmodel: sonnet\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "reader", model: "haiku", effort: "low" }))["model"], "sonnet");
  });

  it("dispatch_raisesPinnedHaikuToSonnet_whenAgentFileListsNoTools", () => {
    sandbox.write(join(sandbox.data, "agents", "fixer.md"), "---\nname: fixer\nmodel: haiku\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "fixer" }))["model"], "sonnet");
  });

  it("dispatch_getsOpus_whenReadOnlyAgentFilePinsHaikuButBriefAsksForVerdict", () => {
    sandbox.write(join(sandbox.data, "agents", "log-reader.md"), "---\nname: log-reader\ntools: Read, Bash\nmodel: haiku\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "log-reader", prompt: "Return a VERDICT line." }))["model"], "opus");
  });

  it("dispatch_capsPinnedFableToOpus_whenAgentFilePinsFable", () => {
    sandbox.write(join(sandbox.data, "agents", "lead.md"), "---\nname: lead\nmodel: fable\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "lead" }))["model"], "opus");
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

  it("modelAssign_passesWithoutFire_whenPayloadIsEmpty", () => {
    assert.equal(sandbox.runHook(MODEL_ASSIGN, { raw: "" }).code, 0);
    assert.deepEqual(sandbox.fires(), []);
  });

  it("modelAssign_passesAndLogsError_whenPayloadNestsPastTheJsonDepthLimit", () => {
    const deep = "[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1);
    const result = sandbox.runHook(MODEL_ASSIGN, { raw: `{"tool_name": "Agent", "deep": ${deep}}` });
    assert.deepEqual([result.code, result.stdout], [0, ""]);
    const [fire] = assertFired(sandbox, "C-dispatch", "error", "model-assign");
    assert.equal(fire?.detail, `RecursionError: JSON nesting is deeper than ${MAX_JSON_DEPTH} levels`);
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
