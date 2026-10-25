import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import {
  AGENT_ID, assertBulletIdsSeeded, assertFired, HookSandbox, KEEL_EVIDENCE_LINE, KEEL_HOME, preToolUse, REPORT_GATE, SESSION_ID, subagentStop,
} from "./helpers.ts";
import type { Fire, HookResult } from "./helpers.ts";
import { evidenceMessage, hasEvidenceToken, REPORT_END, REPORT_START, withoutReportMarkers } from "../../hooks/report-gate/report-gate.ts";

const PASS_REPORT = "VERDICT: PASS\nNo findings. 3 files changed, 40 insertions(+).\n" + KEEL_EVIDENCE_LINE;
const FRAMED_PASS_REPORT = `<<<KEEL-REPORT\n${PASS_REPORT}\nKEEL-REPORT>>>`;
const UNPROVEN_REPORT = "Done. All good, VERDICT: PASS";
const PROVEN_REPORT = "Done.\nRan 12 tests in 0.4s\nOK";
const CLI_RESPONSE = '{"evidence_id":"review-20261011T090000Z-1a2b3c4d","repo":"acme/app","paths":3}';

type ToolUse = readonly [string, unknown];

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

function handback(report: string, options: { toolUses?: ToolUse[]; brief?: string; inSubagent?: boolean; withTranscript?: boolean } = {}): HookResult {
  if (options.withTranscript ?? true) sandbox.agentTranscript(options.brief ?? `[SCOPE] ${scope}\nDo the task.`, options.toolUses ?? []);
  const payload = preToolUse("SubagentHandback", { message: report }, sandbox.root, sandbox.mainTranscript(), options.inSubagent ?? true);
  return sandbox.runHook(REPORT_GATE, { payload });
}

function stop(message: string | null, options: { toolUses?: ToolUse[]; stopHookActive?: boolean; agentTranscript?: string; agentType?: string } = {}): HookResult {
  const path = options.agentTranscript ?? sandbox.agentTranscript(`[SCOPE] ${scope}\nDo the task.`, options.toolUses ?? []);
  const payload = subagentStop(sandbox.root, sandbox.mainTranscript(), path, message, options.stopHookActive ?? false);
  if (options.agentType) payload["agent_type"] = options.agentType;
  return sandbox.runHook(REPORT_GATE, { payload });
}

function contractMisses(): Fire[] {
  return sandbox.fires().filter((fire) => fire.outcome === "contract-miss");
}

function editIn(directory: string, name: string): ToolUse {
  return ["Edit", { file_path: join(directory, name) }];
}

describe("HandbackEvidenceTest", () => {
  it("handback_deniesWithK2_whenVerdictReportHasNoEvidenceToken", () => {
    const result = handback(UNPROVEN_REPORT);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("[K2]"), result.stderr);
    assert.ok(result.stderr.startsWith("[K2] report-gate: "), result.stderr);
    assertBulletIdsSeeded(result.stderr);
    assertFired(sandbox, "K2", "deny", "report-gate");
  });

  it("handback_passesWithK2Pass_whenEvidenceTokenSpellsIWithDottedOrDotlessI", () => {
    for (const report of ["Done. VERDICT: PASS, 3 tests pass\u0131ng", "Done. VERDICT: PASS. NOT VER\u0130F\u0130ED", "Done. VERDICT: PASS, 4 f\u0131les changed"]) {
      assert.equal(handback(report).code, 0, report);
    }
    assert.deepEqual(sandbox.fires().filter((fire) => fire.outcome === "deny"), []);
  });

  it("handback_passes_whenSecondCallInSameTurnStillLacksEvidence", () => {
    handback(UNPROVEN_REPORT);
    assert.equal(handback(UNPROVEN_REPORT).code, 0);
  });

  it("handback_passesWithK2Pass_whenReportCitesTestRunnerSummary", () => {
    const result = handback(PROVEN_REPORT, { toolUses: [editIn(scope, "a.py")] });
    assert.equal(result.code, 0);
    assertFired(sandbox, "K2", "pass", "report-gate");
  });

  it("handback_passesSilently_whenNoContractApplies", () => {
    const result = handback("Here is the list of files you asked about.");
    assert.equal(result.code, 0);
    assert.deepEqual(sandbox.fires(), []);
  });

  it("handback_requiresEvidence_whenBriefCarriesEvidenceMarker", () => {
    assert.equal(handback("Looked into it, looks fine.", { brief: "[EVIDENCE] check the thing" }).code, 2);
  });

  it("handback_requiresEvidence_whenAgentRanWritingBash", () => {
    const result = handback("Updated the config.", { toolUses: [["Bash", { command: `echo x > ${scope}/c.txt` }]] });
    assert.equal(result.code, 2);
  });

  it("handback_logsContractMiss_whenNotInsideSubagent", () => {
    const result = handback(UNPROVEN_REPORT, { inSubagent: false });
    assert.equal(result.code, 0);
    const [miss, ...others] = contractMisses();
    assert.equal(others.length, 0);
    assert.equal(miss?.rule_id, "K2");
    assert.ok(miss?.detail?.includes("missing agent_id;"), miss?.detail);
    assert.ok(miss?.detail?.includes("cc_version=9.9.9"), miss?.detail);
  });

  it("handback_logsContractMiss_whenAgentTranscriptMissing", () => {
    const result = handback(PROVEN_REPORT, { withTranscript: false });
    assert.equal(result.code, 0);
    const misses = contractMisses();
    assert.equal(misses.length, 1);
    assert.ok(misses[0]?.detail?.includes("agent_transcript_path (derived)"), misses[0]?.detail);
  });

  it("handback_logsNoContractMiss_whenPayloadIsComplete", () => {
    handback(PROVEN_REPORT, { toolUses: [editIn(scope, "a.py")] });
    assert.deepEqual(contractMisses(), []);
  });

  it("evidenceMessage_containsNoEvidenceTokenButUnverified_soParrotingCannotPass", () => {
    assert.equal(hasEvidenceToken(evidenceMessage().replaceAll("UNVERIFIED:", "")), false);
  });
});

describe("TurnStateFileTest", () => {
  it("handback_logsNoError_whenStateFileHoldsADictForPaths", () => {
    const state = join(sandbox.data, "state", "keel", "report-gate", `${SESSION_ID}-${AGENT_ID}.json`);
    sandbox.write(state, '{"paths": {"/old/a.py": 1, "/old/b.py": 2}, "ev": false, "hb": false}');
    assert.equal(handback(PROVEN_REPORT, { toolUses: [editIn(scope, "a.py")] }).code, 0);
    assert.deepEqual(sandbox.fires().filter((fire) => fire.outcome === "error"), []);
  });

  it("handback_flagsAnOutsideEditOnce_whenStateFilePathsIsADictKeyedByThePath", () => {
    const state = join(sandbox.data, "state", "keel", "report-gate", `${SESSION_ID}-${AGENT_ID}.json`);
    const outside = join(sandbox.root, "elsewhere", "b.py");
    sandbox.write(state, `{"paths": ${JSON.stringify({ [outside]: 1 })}, "ev": false, "hb": false}`);
    assert.equal(handback(PROVEN_REPORT, { toolUses: [["Write", { file_path: outside, content: "x" }]] }).code, 0);
  });

  it("handback_flagsAnOutsideEditAgain_whenStateFilePathsIsNeitherAListNorADict", () => {
    const state = join(sandbox.data, "state", "keel", "report-gate", `${SESSION_ID}-${AGENT_ID}.json`);
    const outside = join(sandbox.root, "elsewhere", "b.py");
    for (const paths of [JSON.stringify(outside), "5", "true"]) {
      sandbox.write(state, `{"paths": ${paths}, "ev": false, "hb": false}`);
      const result = handback(PROVEN_REPORT, { toolUses: [["Write", { file_path: outside, content: "x" }]] });
      assert.equal(result.code, 2, paths);
      assert.ok(result.stderr.includes("[K5]"), result.stderr);
    }
  });
});

describe("HandbackScopeTest", () => {
  it("handback_deniesWithK5_whenEditOutsideScope", () => {
    const outside = join(sandbox.root, "elsewhere", "b.py");
    const result = handback(PROVEN_REPORT, { toolUses: [["Write", { file_path: outside, content: "x" }]] });
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("[K5]"), result.stderr);
    assert.ok(result.stderr.includes(outside), result.stderr);
    assertFired(sandbox, "K5", "deny", "report-gate");
  });

  it("handback_passes_whenEditInsideScope", () => {
    assert.equal(handback(PROVEN_REPORT, { toolUses: [editIn(join(scope, "sub"), "a.py")] }).code, 0);
  });

  it("handback_passes_whenEditInScratchDir", () => {
    assert.equal(handback(PROVEN_REPORT, { toolUses: [["Write", { file_path: "/tmp/scratch.txt" }]] }).code, 0);
  });

  it("handback_flagsPathOnce_whenSameViolationSeenAgain", () => {
    const uses: ToolUse[] = [["Write", { file_path: join(sandbox.root, "elsewhere", "b.py") }]];
    handback(PROVEN_REPORT, { toolUses: uses });
    assert.equal(handback(PROVEN_REPORT, { toolUses: uses }).code, 0);
  });

  it("handback_truncatesPathList_whenManyEditsAreOutsideScope", () => {
    const uses: ToolUse[] = Array.from({ length: 500 }, (_, index): ToolUse => [
      "Write", { file_path: join(sandbox.root, "elsewhere", `f${String(index).padStart(3, "0")}.py`) },
    ]);
    const result = handback(PROVEN_REPORT, { toolUses: uses });
    assert.equal(result.code, 2);
    assert.ok(Array.from(result.stderr).length <= 2000 + 1, String(Array.from(result.stderr).length));
    assert.ok(result.stderr.includes("…and 490 more"), result.stderr);
  });
});

function keelRequests(): any[] {
  return sandbox.stubCalls("keel").map((call) => JSON.parse(call.stdin));
}

describe("HandbackReviewEvidenceTest", () => {
  it("handback_pipesEvidenceToCli_whenFirstLineIsVerdictPass", () => {
    const result = handback(PASS_REPORT);
    assert.equal(result.code, 0);
    const calls = sandbox.stubCalls("keel");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ["evidence", "write-review"]);
    const request = JSON.parse(calls[0]?.stdin ?? "");
    assert.equal(request.verdict, "PASS");
    assert.equal(request.keel_evidence.review_base, "a".repeat(40));
    const source = request.source;
    assert.deepEqual([source.session_id, source.agent_id, source.via], [SESSION_ID, AGENT_ID, "SubagentHandback"]);
    assert.ok(source.agent_transcript_path.endsWith(`/subagents/workflows/wf-1/agent-${AGENT_ID}.jsonl`), source.agent_transcript_path);
    assert.equal(source.transcript_path, sandbox.mainTranscript());
    assertFired(sandbox, "K1", "record", "report-gate");
  });

  it("handback_warnsK1AndSendsNothing_whenEvidenceLineHoldsANonFiniteNumber", () => {
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      sandbox.close();
      sandbox = new HookSandbox();
      sandbox.env["KEEL_CLI"] = sandbox.stub("keel", { stdout: CLI_RESPONSE });
      sandbox.putStubClaudeOnPath();
      assert.equal(handback(PASS_REPORT.replace('"v":1,', `"v":1,"x":${literal},`)).code, 0);
      assert.deepEqual(sandbox.stubCalls("keel"), [], literal);
      assertFired(sandbox, "K1", "warn", "report-gate");
    }
  });

  it("handback_warnsK1AndSendsNothing_whenEvidenceLineHoldsANumberPastTheDoubleRange", () => {
    for (const number of ["1e400", "-1e400", "1".repeat(4301)]) {
      sandbox.close();
      sandbox = new HookSandbox();
      sandbox.env["KEEL_CLI"] = sandbox.stub("keel", { stdout: CLI_RESPONSE });
      sandbox.putStubClaudeOnPath();
      assert.equal(handback(PASS_REPORT.replace('"v":1,', `"v":1,"x":[${number}],`)).code, 0);
      assert.deepEqual(sandbox.stubCalls("keel"), [], number.slice(0, 8));
      assert.ok(sandbox.fires().some((fire) => fire.rule_id === "K1" && fire.outcome === "warn" && fire.detail === "KEEL-EVIDENCE line is not JSON"), number.slice(0, 8));
    }
  });

  it("handback_sendsNeedsFixes_whenFirstLineIsVerdictNeedsFixes", () => {
    handback(PASS_REPORT.replace("VERDICT: PASS", "VERDICT: NEEDS_FIXES"));
    assert.equal(keelRequests()[0].verdict, "NEEDS_FIXES");
  });

  it("handback_sendsOneRequestPerRepo_whenSeveralEvidenceLines", () => {
    handback(PASS_REPORT + "\n" + KEEL_EVIDENCE_LINE.replace("/work/app", "/work/lib"));
    assert.equal(sandbox.stubCalls("keel").length, 2);
  });

  it("handback_writesNothing_whenVerdictIsNotFirstLine", () => {
    handback("Summary first.\n" + PASS_REPORT);
    assert.deepEqual(sandbox.stubCalls("keel"), []);
  });

  it("handback_pipesEvidenceToCli_whenReporterEchoesTheMarkerLines", () => {
    const result = handback(FRAMED_PASS_REPORT);
    assert.equal(result.code, 0);
    const calls = sandbox.stubCalls("keel");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, ["evidence", "write-review"]);
    const request = JSON.parse(calls[0]?.stdin ?? "");
    assert.equal(request.verdict, "PASS");
    assert.equal(request.keel_evidence.review_base, "a".repeat(40));
    assertFired(sandbox, "K1", "record", "report-gate");
  });

  it("handback_pipesEvidenceToCli_whenReporterEchoesOnlyTheOpeningMarker", () => {
    handback("<<<KEEL-REPORT\n" + PASS_REPORT);
    assert.equal(keelRequests().length, 1);
    assert.equal(keelRequests()[0].verdict, "PASS");
  });

  it("handback_pipesEvidenceToCli_whenReporterStartsWithABlankLine", () => {
    handback("\n" + FRAMED_PASS_REPORT);
    assert.equal(keelRequests().length, 1);
    assert.equal(keelRequests()[0].verdict, "PASS");
  });

  it("handback_pipesEvidenceToCli_whenReporterIndentsTheOpeningMarker", () => {
    handback("  " + FRAMED_PASS_REPORT);
    assert.equal(keelRequests().length, 1);
    assert.equal(keelRequests()[0].verdict, "PASS");
  });

  it("handback_writesNothing_whenPreambleComesBeforeTheMarkerLines", () => {
    handback("Here is the report:\n" + FRAMED_PASS_REPORT);
    assert.deepEqual(sandbox.stubCalls("keel"), []);
  });

  it("handback_warnsK1_whenCliRefuses", () => {
    sandbox.env["KEEL_CLI"] = sandbox.stub("keel-refusing", { exitCode: 3 });
    const result = handback(PASS_REPORT);
    assert.equal(result.code, 0);
    assertFired(sandbox, "K1", "warn", "report-gate");
  });

  it("handback_warnsK1_whenEvidenceLineIsNotJson", () => {
    handback("VERDICT: PASS\n3 files changed\nKEEL-EVIDENCE: {not json}");
    assert.deepEqual(sandbox.stubCalls("keel"), []);
    assertFired(sandbox, "K1", "warn", "report-gate");
  });

  it("handback_warnsK1_whenAgentTranscriptMissing", () => {
    handback(PASS_REPORT, { withTranscript: false });
    assert.deepEqual(sandbox.stubCalls("keel"), []);
    assertFired(sandbox, "K1", "warn", "report-gate");
  });

  it("handback_refusesEvidence_whenReviewerUsedAnEditTool", () => {
    const result = handback(PASS_REPORT, { toolUses: [editIn(scope, "a.py")] });
    assert.equal(result.code, 0);
    assert.deepEqual(sandbox.stubCalls("keel"), []);
    const warns = assertFired(sandbox, "K1", "warn", "report-gate");
    assert.ok(warns[0]?.detail?.startsWith("reviewer-mutated"), JSON.stringify(warns));
  });

  it("handback_refusesEvidence_whenReviewerRanSedInPlaceOutsideScratch", () => {
    handback(PASS_REPORT, { toolUses: [["Bash", { command: `sed -i '' s/a/b/ ${scope}/a.py` }]] });
    assert.deepEqual(sandbox.stubCalls("keel"), []);
    assertFired(sandbox, "K1", "warn", "report-gate");
  });

  it("handback_writesEvidence_whenReviewerOnlyReadAndWroteUnderTmp", () => {
    const uses: ToolUse[] = [
      ["Bash", { command: "git diff --stat > /tmp/review-notes.txt" }],
      ["Bash", { command: `keel snapshot ${scope}` }],
      ["Read", { file_path: join(scope, "a.py") }],
    ];
    handback(PASS_REPORT, { toolUses: uses });
    assert.equal(sandbox.stubCalls("keel").length, 1);
  });
});

describe("ReportMarkersTest", () => {
  it("reportMarkers_matchLensReviewWorkflow_soBothSidesStripTheSameLines", () => {
    const source = readFileSync(join(KEEL_HOME, "workflows", "lens-review.js"), "utf8");
    assert.ok(source.includes(`const REPORT_START = '${REPORT_START}'`));
    assert.ok(source.includes(`const REPORT_END = '${REPORT_END}'`));
  });

  it("withoutReportMarkers_dropsTheClosingMarker_whenReporterEchoesOnlyThatLine", () => {
    assert.equal(withoutReportMarkers(PASS_REPORT + "\nKEEL-REPORT>>>"), PASS_REPORT);
  });

  it("withoutReportMarkers_dropsTheClosingMarker_whenReporterIndentsIt", () => {
    assert.equal(withoutReportMarkers(PASS_REPORT + "\n  KEEL-REPORT>>>"), PASS_REPORT);
  });

  it("withoutReportMarkers_dropsBothMarkers_whenReporterUsesCrlfAndIndentsTheClosingMarker", () => {
    const report = withoutReportMarkers("<<<KEEL-REPORT\r\n" + PASS_REPORT.replaceAll("\n", "\r\n") + "\r\n  KEEL-REPORT>>>");
    assert.equal(report, PASS_REPORT);
  });
});

describe("SubagentStopTest", () => {
  it("stop_blocksWithK2_whenMutatingAgentReportsWithoutEvidence", () => {
    const result = stop("Changed it.", { toolUses: [editIn(scope, "a.py")] });
    assert.equal(result.code, 0);
    assert.equal(result.json().decision, "block");
    assert.ok(result.json().reason.includes("[K2]"));
    assert.ok(result.json().reason.startsWith("[K2] report-gate: "));
  });

  it("stop_passes_whenStopHookActive", () => {
    const result = stop("Changed it.", { toolUses: [editIn(scope, "a.py")], stopHookActive: true });
    assert.equal(result.stdout, "");
  });

  it("stop_blocksWithK5_whenEditOutsideScope", () => {
    const result = stop(PROVEN_REPORT, { toolUses: [["Edit", { file_path: "/elsewhere/x.py" }]] });
    assert.ok(result.json().reason.includes("[K5]"));
  });

  it("stop_writesEvidenceViaStop_whenNoHandbackThisTurn", () => {
    stop(PASS_REPORT);
    assert.equal(keelRequests()[0].source.via, "SubagentStop");
  });

  it("stop_writesEvidence_whenReporterEchoesTheMarkerLines", () => {
    stop(FRAMED_PASS_REPORT);
    const request = keelRequests()[0];
    assert.deepEqual([request.verdict, request.source.via], ["PASS", "SubagentStop"]);
    assertFired(sandbox, "K1", "record", "report-gate");
  });

  it("stop_writesEvidenceWithTheReporterType_whenTheLensReviewReporterStops", () => {
    const result = stop(FRAMED_PASS_REPORT, { agentType: "keel-reporter" });
    assert.equal(result.code, 0);
    const requests = keelRequests();
    assert.equal(requests.length, 1);
    assert.deepEqual([requests[0].source.agent_type, requests[0].source.via], ["keel-reporter", "SubagentStop"]);
    assertFired(sandbox, "K1", "record", "report-gate");
  });

  it("stop_refusesEvidence_whenReviewerEdited", () => {
    stop(PASS_REPORT, { toolUses: [["Write", { file_path: join(scope, "a.py"), content: "x" }]] });
    assert.deepEqual(sandbox.stubCalls("keel"), []);
    assertFired(sandbox, "K1", "warn", "report-gate");
  });

  it("stop_skipsJudgingAndWriting_whenReportWasHandedBackThisTurn", () => {
    handback(PASS_REPORT);
    const result = stop("Wrap-up: report delivered.", { toolUses: [editIn(scope, "a.py")] });
    assert.equal(result.stdout, "");
    assert.equal(sandbox.stubCalls("keel").length, 1);
  });

  it("stop_judgesAgain_whenNextTurnHasNoHandback", () => {
    handback(PASS_REPORT);
    stop("wrap-up");
    const result = stop("Changed it.", { toolUses: [editIn(scope, "a.py")] });
    assert.equal(result.json().decision, "block");
  });

  it("stop_passes_whenAgentEndedWithStructuredOutput", () => {
    const result = stop("ok", { toolUses: [editIn(scope, "a.py"), ["StructuredOutput", { x: 1 }]] });
    assert.equal(result.stdout, "");
  });

  it("stop_warnsK2AndLogsContractMiss_whenMutatingAgentLeftNoFinalText", () => {
    const result = stop(null, { toolUses: [editIn(scope, "a.py")] });
    assert.equal(result.stdout, "");
    assertFired(sandbox, "K2", "warn", "report-gate");
    const misses = contractMisses();
    assert.equal(misses.length, 1);
    assert.ok(misses[0]?.detail?.includes("missing last_assistant_message;"), misses[0]?.detail);
  });

  it("stop_logsNoContractMiss_whenPayloadIsComplete", () => {
    stop(PROVEN_REPORT);
    assert.deepEqual(contractMisses(), []);
  });

  it("stop_passes_whenAgentTranscriptNeverWritten", () => {
    const result = stop("Changed it.", { agentTranscript: join(sandbox.root, "missing.jsonl") });
    assert.equal(result.stdout, "");
    assert.deepEqual(sandbox.fires(), []);
  });

  it("stop_warnsK1_whenTranscriptNeverWrittenAndReportIsAReview", () => {
    const result = stop(PASS_REPORT, { agentTranscript: join(sandbox.root, "missing.jsonl") });
    assert.equal(result.stdout, "");
    assert.deepEqual(sandbox.stubCalls("keel"), []);
    assertFired(sandbox, "K1", "warn", "report-gate");
  });

  it("stop_refusesWithK2_whenATranscriptLineHoldsANonFiniteNumber", () => {
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      sandbox.close();
      sandbox = new HookSandbox();
      const path = sandbox.agentTranscript(`[SCOPE] ${scope}\nDo the task.`);
      const edit = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/elsewhere/b.py" } }] }, x: 0 };
      sandbox.write(path, readFileSync(path, "utf8") + JSON.stringify(edit).replace(/"x":0/, `"x":${literal}`) + "\n");
      const result = stop("Changed it.", { agentTranscript: path });
      assert.match(result.stdout, /"decision": "block"/, literal);
      assert.match(result.stdout, /could not check this report; refusing it/, literal);
      assert.ok(sandbox.fires().some((fire) => fire.rule_id === "K2" && fire.outcome === "error" && String(fire.detail).startsWith("NonFiniteJsonNumber:")), literal);
    }
  });

  it("stop_passesAndLogsError_whenTranscriptUnreadable", () => {
    const unreadable = join(sandbox.root, "a-directory");
    mkdirSync(unreadable);
    const result = stop("Changed it.", { agentTranscript: unreadable });
    assert.equal(result.code, 0);
    const [fire] = assertFired(sandbox, "K2", "error", "report-gate");
    assert.match(fire?.detail ?? "", /^Error: EISDIR: illegal operation on a directory, read$/);
  });

  it("reportGate_passesAndLogsError_whenPayloadIsNotJson", () => {
    assert.equal(sandbox.runHook(REPORT_GATE, { raw: "not json" }).code, 0);
    assertFired(sandbox, "K2", "error", "report-gate");
  });
});
