import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AGENT_ID, HookSandbox, preToolUse, REPORT_GATE, SESSION_ID, subagentStop } from "./helpers.ts";
import type { HookResult } from "./helpers.ts";
import { BRIEF, EDIT_PATH, filled, loadFixtures, REPORT, scrubTranscript, versionOf } from "./harness-contract.ts";
import type { Fixture } from "./harness-contract.ts";
import { finalReport } from "../../hooks/lib/hookkit/transcript.ts";

const UNPROVEN_REPORT = "Done. All good, VERDICT: PASS";
const PLAIN_REPORT = "Done.";
const PROVEN_REPORT = "Done.\nRan 12 tests in 0.4s\nOK";
const CLI_RESPONSE = '{"evidence_id":"review-20261011T090000Z-1a2b3c4d","repo":"acme/app","paths":3}';
const FIXTURES = new Map(loadFixtures().map((fixture) => [fixture.name, fixture]));

let sandbox: HookSandbox;
let scope: string;

beforeEach(() => {
  sandbox = new HookSandbox();
  sandbox.env["KEEL_CLI"] = sandbox.stub("keel", { stdout: CLI_RESPONSE });
  sandbox.putStubClaudeOnPath();
  scope = join(sandbox.root, "work", "app");
});

afterEach(() => {
  sandbox.close();
});

function fixture(name: string): Fixture {
  const found = FIXTURES.get(name);
  assert.ok(found, `no harness-contract fixture ${name}`);
  return found;
}

function installRecorded(name: string, report: string, editPath = join(scope, "a.ts")): string {
  const path = join(sandbox.data, "projects", "-work-app", SESSION_ID, "subagents", "workflows", "wf-1", `agent-${AGENT_ID}.jsonl`);
  sandbox.write(path, filled(fixture(name), { brief: `[SCOPE] ${scope}\nDo the task.`, report, editPath }));
  sandbox.write(sandbox.mainTranscript(), "");
  return path;
}

function stopWithoutMessage(name: string, report: string): HookResult {
  const path = installRecorded(name, report);
  return sandbox.runHook(REPORT_GATE, { payload: subagentStop(sandbox.root, sandbox.mainTranscript(), path, null) });
}

function handback(name: string, report: string, editPath?: string): HookResult {
  installRecorded(name, report, editPath);
  return sandbox.runHook(REPORT_GATE, { payload: preToolUse("SubagentHandback", { message: report }, sandbox.root, sandbox.mainTranscript(), true) });
}

function fired(): string[] {
  return sandbox.fires().map((fire) => `${fire.rule_id}/${fire.outcome}`);
}

describe("HarnessContractTest", () => {
  it("stopWithoutMessage_deniesK2_fromTheFinalTextOfARecordedReporter", () => {
    stopWithoutMessage("reporter-final-text", UNPROVEN_REPORT);
    assert.deepEqual(fired(), ["K2/deny"]);
  });

  it("stopWithoutMessage_deniesK2_fromTheFinalTextOfARecordedWorkerThatEdited", () => {
    stopWithoutMessage("worker-edits-final-text", PLAIN_REPORT);
    assert.deepEqual(fired(), ["K2/deny"]);
  });

  it("stopWithoutMessage_isNoContractMiss_whenTheRecordedReporterEndsInAHandback", () => {
    stopWithoutMessage("reporter-handback", PLAIN_REPORT);
    assert.deepEqual(fired(), []);
  });

  it("stopWithoutMessage_isNoContractMiss_whenTheRecordedWorkerEndsInAHandback", () => {
    stopWithoutMessage("worker-edits-handback", PLAIN_REPORT);
    assert.deepEqual(fired(), []);
  });

  it("handbackWithoutEvidence_deniesK2_fromTheEditsOfARecordedWorker", () => {
    const result = handback("worker-edits-final-text", PLAIN_REPORT);
    assert.equal(result.code, 2);
    assert.deepEqual(fired(), ["K2/deny"]);
  });

  it("handbackWithoutEvidence_deniesK2_fromTheWriteOfARecordedWorker", () => {
    const result = handback("worker-edits-handback", PLAIN_REPORT);
    assert.equal(result.code, 2);
    assert.deepEqual(fired(), ["K2/deny"]);
  });

  it("handback_deniesK5_fromTheBriefScopeOfARecordedWorker_whenItsEditFallsOutsideIt", () => {
    const outside = join(sandbox.root, "elsewhere", "b.ts");
    const result = handback("worker-edits-final-text", PROVEN_REPORT, outside);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("[K5]") && result.stderr.includes(outside), result.stderr);
    assert.deepEqual(fired(), ["K5/deny"]);
  });

  it("handbackWithoutEvidence_passes_whenTheRecordedReporterEditedNothing", () => {
    const result = handback("reporter-handback", PLAIN_REPORT);
    assert.equal(result.code, 0);
    assert.deepEqual(fired(), []);
  });
});

describe("FinalReportTest", () => {
  it("finalReport_readsTheReportEveryRecordedTranscriptCarries_finalTextOrHandbackMessage", () => {
    const reports = loadFixtures().map((recorded) => {
      const report = `VERDICT: PASS from ${recorded.name}`;
      return [recorded.name, finalReport(installRecorded(recorded.name, report)) === report];
    });
    assert.deepEqual(reports, loadFixtures().map((recorded) => [recorded.name, true]));
  });

  it("finalReport_isNull_whenTheTranscriptEndsInAToolUseThatIsNotAHandback", () => {
    const path = join(sandbox.root, "ends-in-read.jsonl");
    sandbox.write(path, [
      { message: { role: "assistant", content: [{ type: "text", text: "draft" }] } },
      { message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    assert.equal(finalReport(path), null);
  });
});

describe("HarnessContractFixtureTest", () => {
  it("fixtures_coverBothEndingsOfBothAgentKinds", () => {
    assert.deepEqual([...FIXTURES.keys()], ["reporter-final-text", "reporter-handback", "worker-edits-final-text", "worker-edits-handback"]);
  });

  it("fixtures_areScrubbed_soScrubbingThemAgainChangesNothing", () => {
    for (const recorded of FIXTURES.values()) assert.equal(scrubTranscript(recorded.text), recorded.text, recorded.name);
  });

  it("fixtures_eachCarryOneHarnessVersion", () => {
    assert.deepEqual([...FIXTURES.values()].map((recorded) => [recorded.name, recorded.version]), [
      ["reporter-final-text", "2.1.309"], ["reporter-handback", "2.1.321"], ["worker-edits-final-text", "2.1.321"], ["worker-edits-handback", "2.1.325"],
    ]);
  });

  it("versionOf_throws_whenAFixtureMixesHarnessVersions", () => {
    assert.throws(() => versionOf('{"version":"2.1.1"}\n{"version":"2.1.2"}\n'), /exactly one harness version/);
    assert.throws(() => versionOf('{"type":"user"}\n'), /exactly one harness version/);
  });
});

describe("ScrubTranscriptTest", () => {
  const raw = [
    { type: "user", version: "9.9.9", cwd: "/Users/someone/repo", message: { role: "user", content: "[SCOPE] /Users/someone/repo\nsecret brief" } },
    { type: "assistant", version: "9.9.9", message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_01AbC", name: "Edit", input: { file_path: "/Users/someone/repo/a.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "toolu_01DeF", name: "mcp__1e974420-7e39__notion-fetch", input: { id: "page-id", role: "someone@example.com", type: "private" } },
    ] }, wireToolInputs: { toolu_01AbC: { command: "rm x", version: "private" } }, toolUseResult: { type: "private", stop_reason: "private" } },
    { type: "assistant", version: "9.9.9", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01GhI", name: "SubagentHandback", input: { message: "VERDICT: PASS someone@example.com" } }] } },
    { type: "assistant", version: "9.9.9", message: { role: "assistant", content: [{ type: "text", text: "final words" }, { type: "text", text: "more words" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

  it("scrubTranscript_replacesEveryStringButStructure_andPlacesTheConsumedFields", () => {
    const lines = scrubTranscript(raw).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { type: "user", version: "9.9.9", cwd: "x", message: { role: "user", content: BRIEF } },
      { type: "assistant", version: "9.9.9", message: { role: "assistant", content: [
        { type: "tool_use", id: "x", name: "Edit", input: { file_path: EDIT_PATH, old_string: "x", new_string: "x" } },
        { type: "tool_use", id: "x", name: "mcp__server__notion-fetch", input: { id: "x", role: "x", type: "x" } },
      ] }, wireToolInputs: { toolu_0: { command: "x", version: "x" } }, toolUseResult: { type: "x", stop_reason: "x" } },
      { type: "assistant", version: "9.9.9", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "SubagentHandback", input: { message: REPORT } }] } },
      { type: "assistant", version: "9.9.9", message: { role: "assistant", content: [{ type: "text", text: REPORT }, { type: "text", text: "" }] } },
    ]);
  });
});
