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

  it("dispatch_passesUntouched_whenAgentDispatchNamesFable", () => {
    const result = dispatch({ model: "fable", effort: "high" });
    assert.equal(result.stdout, "");
    assertFired(sandbox, "C-dispatch", "pass", "model-assign");
  });

  it("dispatch_passesUntouched_whenFableIsNamedAndBriefAsksForVerdict", () => {
    assert.equal(dispatch({ model: "fable", effort: "high", prompt: "Return a VERDICT line." }).stdout, "");
  });

  for (const model of ["mythos", "claude-fable-5-2", "Fable"]) {
    it(`dispatch_passesUntouched_whenTheNamedModelIs_${model}`, () => {
      assert.equal(dispatch({ model, effort: "high" }).stdout, "");
    });
  }

  it("dispatch_addsOnlyTheEffort_whenFableIsNamedWithoutOne", () => {
    const result = updated(dispatch({ model: "fable" }));
    assert.deepEqual([result["model"], result["effort"]], ["fable", "medium"]);
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

  for (const pinned of ["fable", "mythos"]) {
    it(`dispatch_keepsModelUnset_whenAgentFilePins_${pinned}`, () => {
      sandbox.write(join(sandbox.data, "agents", "lead.md"), `---\nname: lead\nmodel: ${pinned}\n---\nBody\n`);
      assert.equal(updated(dispatch({ subagent_type: "lead" }))["model"], undefined);
    });

    it(`dispatch_keepsModelUnset_whenAgentFilePins_${pinned}_andBriefAsksForVerdict`, () => {
      sandbox.write(join(sandbox.data, "agents", "lead.md"), `---\nname: lead\nmodel: ${pinned}\n---\nBody\n`);
      assert.equal(updated(dispatch({ subagent_type: "lead", prompt: "Return a VERDICT line." }))["model"], undefined);
    });
  }

  it("dispatch_getsOpus_whenAgentFilePinsInheritAndBriefAsksForVerdict", () => {
    sandbox.write(join(sandbox.data, "agents", "inheritor.md"), "---\nname: inheritor\ntools: Read, Grep\nmodel: inherit\n---\nBody\n");
    assert.equal(updated(dispatch({ subagent_type: "inheritor", prompt: "Return a VERDICT line." }))["model"], "opus");
  });
});

const OPUS_PIN = "---\nname: developer\nmodel: opus\n---\nBody\n";

function dispatchFrom(cwd: string, toolInput: Record<string, unknown>, permissionMode = "default"): HookResult {
  const input = { description: "Build it", prompt: "Add the flag to parse().", ...toolInput };
  return sandbox.runHook(MODEL_ASSIGN, { payload: { ...preToolUse("Agent", input, cwd), permission_mode: permissionMode }, cwd });
}

function installPlugin(key: string, installPath: string): void {
  const record = { version: 2, plugins: { [key]: [{ scope: "user", installPath, version: "1.0.0" }] } };
  sandbox.write(join(sandbox.data, "plugins", "installed_plugins.json"), JSON.stringify(record));
}

describe("AgentFileLocationTest", () => {
  it("dispatch_keepsTheProjectAgentPin_whenCwdIsInsideTheRepository", () => {
    const repo = sandbox.makeRepo("acme", "app");
    sandbox.write(join(repo, ".claude", "agents", "developer.md"), OPUS_PIN);
    sandbox.write(join(repo, "src", "keep.txt"), "");
    const result = dispatchFrom(join(repo, "src"), { subagent_type: "developer" });
    assert.equal(updated(result)["model"], undefined);
    assert.equal(updated(result)["effort"], "medium");
  });

  it("dispatch_leavesTheProjectAgentPinOutOfTheDeny_whenAutoMode", () => {
    const repo = sandbox.makeRepo("acme", "app");
    sandbox.write(join(repo, ".claude", "agents", "developer.md"), OPUS_PIN);
    const result = dispatchFrom(repo, { subagent_type: "developer" }, "auto");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /with effort: "medium" set/);
    assert.doesNotMatch(result.stderr, /sonnet/);
  });

  it("dispatch_prefersTheProjectAgentFile_whenTheUserDirectoryHasTheSameName", () => {
    const repo = sandbox.makeRepo("acme", "app");
    sandbox.write(join(repo, ".claude", "agents", "developer.md"), OPUS_PIN);
    sandbox.write(join(sandbox.data, "agents", "developer.md"), "---\nname: developer\nmodel: haiku\n---\nBody\n");
    assert.equal(dispatchFrom(repo, { subagent_type: "developer", effort: "high" }).stdout, "");
  });

  it("dispatch_keepsAnotherPluginsAgentPin_whenItIsInstalled", () => {
    const installPath = join(sandbox.root, "cache", "acme", "1.0.0");
    installPlugin("acme@market", installPath);
    sandbox.write(join(installPath, "agents", "developer.md"), OPUS_PIN);
    assert.equal(dispatchFrom(sandbox.root, { subagent_type: "acme:developer", effort: "high" }).stdout, "");
  });

  it("dispatch_assignsSonnet_whenThePluginIsNotInstalled", () => {
    const installPath = join(sandbox.root, "cache", "acme", "1.0.0");
    installPlugin("other@market", installPath);
    sandbox.write(join(installPath, "agents", "developer.md"), OPUS_PIN);
    assert.equal(updated(dispatchFrom(sandbox.root, { subagent_type: "acme:developer", effort: "high" }))["model"], "sonnet");
  });

  for (const [label, text] of [["WrongShape", "{\"plugins\": [1]}"], ["NotJson", "{plugins"]]) {
    it(`dispatch_assignsSonnet_whenThePluginRecordIs_${label}`, () => {
      sandbox.write(join(sandbox.data, "plugins", "installed_plugins.json"), text);
      assert.equal(updated(dispatchFrom(sandbox.root, { subagent_type: "acme:developer", effort: "high" }))["model"], "sonnet");
    });
  }
});

const LONG_BRIEF = "Update the parser so every caller passes the new flag. ".repeat(10);
const SHORT_BRIEF = "Find every caller of parse(), then list each file with its line number. ".repeat(8).slice(0, 499);

function dispatchInAutoMode(toolInput: Record<string, unknown> = {}): HookResult {
  const input = { description: "Find callers", prompt: "Find every caller of parse().", ...toolInput };
  return sandbox.runHook(MODEL_ASSIGN, { payload: { ...preToolUse("Agent", input, sandbox.root), permission_mode: "auto" } });
}

describe("AutoModeDispatchTest", () => {
  it("dispatch_deniesWithTheValuesToAdd_whenAutoModeAndModelAndEffortOmitted", () => {
    const result = dispatchInAutoMode();
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /model: "sonnet", effort: "medium"/);
    assertFired(sandbox, "C-dispatch", "deny", "model-assign");
  });

  it("dispatch_namesBothValues_whenAutoModeAndOnlyTheModelIsBelowTheFloor", () => {
    const result = dispatchInAutoMode({ model: "haiku", effort: "high" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /model: "sonnet", effort: "high"/);
  });

  it("dispatch_passes_whenAutoModeAndAgentDispatchNamesFable", () => {
    const result = dispatchInAutoMode({ model: "fable", effort: "high" });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, "", ""]);
  });

  it("dispatch_keepsFableInTheValuesToSet_whenAutoModeAndEffortOmitted", () => {
    const result = dispatchInAutoMode({ model: "fable" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /model: "fable", effort: "medium"/);
  });

  it("dispatch_namesOnlyTheModel_whenAutoModeAndAgentFilePinsEffort", () => {
    sandbox.write(join(sandbox.data, "agents", "worker-pinned.md"), "---\nname: worker-pinned\neffort: low\n---\nBody\n");
    const result = dispatchInAutoMode({ subagent_type: "worker-pinned", model: "haiku", effort: ["x"] });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /model: "sonnet"/);
    assert.doesNotMatch(result.stderr, /effort:/);
  });

  it("dispatch_leavesThePinnedModelOut_whenAutoModeAndAgentFilePinsAnInBandModel", () => {
    sandbox.write(join(sandbox.data, "agents", "lead.md"), "---\nname: lead\nmodel: opus\n---\nBody\n");
    const result = dispatchInAutoMode({ subagent_type: "lead" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /with effort: "medium" set/);
    assert.doesNotMatch(result.stderr, /model: ""/);
  });

  it("dispatch_carriesTheBriefHintInTheDeny_whenAutoModeAndPromptIsLong", () => {
    const result = dispatchInAutoMode({ prompt: LONG_BRIEF });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /deepening-prompts/);
  });

  it("dispatch_passes_whenAutoModeAndModelAndEffortInBand", () => {
    const result = dispatchInAutoMode({ model: "sonnet", effort: "medium" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

function contextOf(result: HookResult): string | undefined {
  return result.json().hookSpecificOutput.additionalContext;
}

describe("BriefSkillHintTest", () => {
  it("dispatch_hintsBriefSkills_whenPromptIsLong", () => {
    const result = dispatch({ prompt: LONG_BRIEF });
    assert.match(contextOf(result) ?? "", /^keel: a long agent brief .*\/deepening-prompts.*\/authoring-agents/);
    assert.deepEqual([updated(result)["model"], updated(result)["effort"], updated(result)["prompt"]], ["sonnet", "medium", LONG_BRIEF]);
    assertFired(sandbox, "C-dispatch", "warn", "model-assign");
  });

  it("dispatch_hintsWithoutRewrite_whenPromptIsLongAndModelAndEffortInBand", () => {
    const result = dispatch({ prompt: LONG_BRIEF, model: "sonnet", effort: "low" });
    assert.equal(result.json().hookSpecificOutput.updatedInput, undefined);
    assert.match(contextOf(result) ?? "", /deepening-prompts/);
    assertFired(sandbox, "C-dispatch", "warn", "model-assign");
  });

  it("dispatch_givesNoHint_whenPromptIsBelowTheThreshold", () => {
    assert.equal(SHORT_BRIEF.length, 499);
    assert.equal(contextOf(dispatch({ prompt: SHORT_BRIEF })), undefined);
    assert.equal(sandbox.fires().filter((fire) => fire.outcome === "warn").length, 0);
  });

  it("dispatch_hintsBriefSkills_whenPromptIsExactlyAtTheThreshold", () => {
    assert.match(contextOf(dispatch({ prompt: SHORT_BRIEF + "x" })) ?? "", /deepening-prompts/);
  });

  for (const subagentType of ["keel:auditor", "keel:reporter", "keel:comment-reviewer", "Keel:Auditor"]) {
    it(`dispatch_givesNoHint_whenSubagentTypeIs_${subagentType}`, () => {
      const result = dispatch({ prompt: LONG_BRIEF, subagent_type: subagentType });
      assert.equal(contextOf(result), undefined);
      assert.equal(updated(result)["model"], "sonnet");
    });
  }

  it("dispatch_givesNoHint_whenIssuedFromInsideASubagent", () => {
    const payload = preToolUse("Agent", { description: "Find callers", prompt: LONG_BRIEF }, sandbox.root, "/dev/null", true);
    assert.equal(contextOf(sandbox.runHook(MODEL_ASSIGN, { payload })), undefined);
    assert.match(contextOf(dispatch({ prompt: LONG_BRIEF })) ?? "", /deepening-prompts/);
  });

  it("dispatch_hintsOncePerSession_whenSeveralLongBriefsFollow", () => {
    assert.match(contextOf(dispatch({ prompt: LONG_BRIEF })) ?? "", /deepening-prompts/);
    const second = dispatch({ prompt: LONG_BRIEF });
    assert.equal(contextOf(second), undefined);
    assert.equal(updated(second)["model"], "sonnet");
    assert.equal(sandbox.fires().filter((fire) => fire.outcome === "warn").length, 1);
  });

  it("dispatch_hintsAgain_whenALongBriefComesFromAnotherSession", () => {
    dispatch({ prompt: LONG_BRIEF });
    const input = { description: "Find callers", prompt: LONG_BRIEF };
    const payload = { ...preToolUse("Agent", input, sandbox.root), session_id: "99999999-2222-3333-4444-555555555555" };
    assert.match(contextOf(sandbox.runHook(MODEL_ASSIGN, { payload })) ?? "", /deepening-prompts/);
  });

  it("dispatch_hintsLaterBrief_whenOnlyAReviewDispatchCameBefore", () => {
    dispatch({ prompt: LONG_BRIEF, subagent_type: "keel:auditor" });
    assert.match(contextOf(dispatch({ prompt: LONG_BRIEF })) ?? "", /deepening-prompts/);
  });

  it("dispatch_stillRewrites_whenTheStateDirectoryCannotBeWritten", () => {
    sandbox.write(join(sandbox.data, "state"), "not a directory");
    const result = dispatch({ prompt: LONG_BRIEF });
    assert.equal(contextOf(result), undefined);
    assert.deepEqual([updated(result)["model"], updated(result)["effort"]], ["sonnet", "medium"]);
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
