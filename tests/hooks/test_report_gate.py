import importlib.util
import json
import os
import unittest

import helpers
from helpers import AGENT_ID, REPORT_GATE, SESSION_ID, pre_tool_use, subagent_stop

EVIDENCE_LINE = (
    'KEEL-EVIDENCE: {"v":1,"repo_root":"/work/app","review_base":"%s","head":null,"snapshot_tree":"%s",'
    '"since":null,"run_id":"rv-20261011T085500Z-7f3e21","root_run_id":"rv-20261011T085500Z-7f3e21",'
    '"review_kind":"lens-review"}' % ("a" * 40, "b" * 40)
)
PASS_REPORT = "VERDICT: PASS\nNo findings. 3 files changed, 40 insertions(+).\n" + EVIDENCE_LINE
UNPROVEN_REPORT = "Done. All good, VERDICT: PASS"
PROVEN_REPORT = "Done.\nRan 12 tests in 0.4s\nOK"


def load_report_gate():
    spec = importlib.util.spec_from_file_location("report_gate", os.path.join(helpers.KEEL_HOME, REPORT_GATE))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReportGateTestCase(helpers.SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.cli = self.sandbox.stub("keel", stdout='{"evidence_id":"review-20261011T090000Z-1a2b3c4d","repo":"acme/app","paths":3}')
        self.sandbox.env["KEEL_CLI"] = self.cli
        self.sandbox.stub_claude()
        self.scope = os.path.join(self.sandbox.root, "work", "app")

    def handback(self, report, tool_uses=(), brief=None, in_subagent=True, with_transcript=True):
        if with_transcript:
            self.sandbox.agent_transcript(brief or "[SCOPE] %s\nDo the task." % self.scope, tool_uses)
        payload = pre_tool_use("SubagentHandback", {"message": report}, self.sandbox.root,
                               transcript_path=self.sandbox.main_transcript(), in_subagent=in_subagent)
        return self.sandbox.run_hook(REPORT_GATE, payload)

    def stop(self, message, tool_uses=(), stop_hook_active=False, agent_transcript=None):
        path = agent_transcript or self.sandbox.agent_transcript("[SCOPE] %s\nDo the task." % self.scope, tool_uses)
        payload = subagent_stop(self.sandbox.root, self.sandbox.main_transcript(), path, message, stop_hook_active)
        return self.sandbox.run_hook(REPORT_GATE, payload)

    def contract_misses(self) -> list:
        return [fire for fire in self.sandbox.fires() if fire["outcome"] == "contract-miss"]


class HandbackEvidenceTest(ReportGateTestCase):
    def test_handback_deniesWithK2_whenVerdictReportHasNoEvidenceToken(self):
        # when
        result = self.handback(UNPROVEN_REPORT)
        # then
        self.assertEqual(2, result.code)
        self.assertIn("[K2]", result.stderr)
        self.assertTrue(result.stderr.startswith("[K2] report-gate: "), result.stderr)
        self.assertBulletIdsSeeded(result.stderr)
        self.assertFired("K2", "deny", "report-gate")

    def test_handback_passes_whenSecondCallInSameTurnStillLacksEvidence(self):
        self.handback(UNPROVEN_REPORT)
        result = self.handback(UNPROVEN_REPORT)
        self.assertEqual(0, result.code)

    def test_handback_passesWithK2Pass_whenReportCitesTestRunnerSummary(self):
        result = self.handback(PROVEN_REPORT, tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        self.assertEqual(0, result.code)
        self.assertFired("K2", "pass", "report-gate")

    def test_handback_passesSilently_whenNoContractApplies(self):
        result = self.handback("Here is the list of files you asked about.")
        self.assertEqual(0, result.code)
        self.assertEqual([], self.sandbox.fires())

    def test_handback_requiresEvidence_whenBriefCarriesEvidenceMarker(self):
        result = self.handback("Looked into it, looks fine.", brief="[EVIDENCE] check the thing")
        self.assertEqual(2, result.code)

    def test_handback_requiresEvidence_whenAgentRanWritingBash(self):
        result = self.handback("Updated the config.", tool_uses=[("Bash", {"command": "echo x > %s/c.txt" % self.scope})])
        self.assertEqual(2, result.code)

    def test_handback_logsContractMiss_whenNotInsideSubagent(self):
        # given a hand-back payload without agent_id (the contract promises one inside a subagent)
        result = self.handback(UNPROVEN_REPORT, in_subagent=False)
        # then: nothing is judged, the miss is logged with the version
        self.assertEqual(0, result.code)
        miss, = self.contract_misses()
        self.assertEqual("K2", miss["rule_id"])
        self.assertIn("missing agent_id;", miss["detail"])
        self.assertIn("cc_version=9.9.9", miss["detail"])

    def test_handback_logsContractMiss_whenAgentTranscriptMissing(self):
        result = self.handback(PROVEN_REPORT, with_transcript=False)
        self.assertEqual(0, result.code)
        miss, = self.contract_misses()
        self.assertIn("agent_transcript_path (derived)", miss["detail"])

    def test_handback_logsNoContractMiss_whenPayloadIsComplete(self):
        self.handback(PROVEN_REPORT, tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        self.assertEqual([], self.contract_misses())

    def test_evidenceMessage_containsNoEvidenceTokenButUnverified_soParrotingCannotPass(self):
        module = load_report_gate()
        message = module._evidence_message()
        self.assertIsNone(module.EVIDENCE_RE.search(message.replace("UNVERIFIED:", "")))


class HandbackScopeTest(ReportGateTestCase):
    def test_handback_deniesWithK5_whenEditOutsideScope(self):
        outside = os.path.join(self.sandbox.root, "elsewhere", "b.py")
        result = self.handback(PROVEN_REPORT, tool_uses=[("Write", {"file_path": outside, "content": "x"})])
        self.assertEqual(2, result.code)
        self.assertIn("[K5]", result.stderr)
        self.assertIn(outside, result.stderr)
        self.assertFired("K5", "deny", "report-gate")

    def test_handback_passes_whenEditInsideScope(self):
        result = self.handback(PROVEN_REPORT, tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "sub", "a.py")})])
        self.assertEqual(0, result.code)

    def test_handback_passes_whenEditInScratchDir(self):
        result = self.handback(PROVEN_REPORT, tool_uses=[("Write", {"file_path": "/tmp/scratch.txt"})])
        self.assertEqual(0, result.code)

    def test_handback_flagsPathOnce_whenSameViolationSeenAgain(self):
        uses = [("Write", {"file_path": os.path.join(self.sandbox.root, "elsewhere", "b.py")})]
        self.handback(PROVEN_REPORT, tool_uses=uses)
        result = self.handback(PROVEN_REPORT, tool_uses=uses)
        self.assertEqual(0, result.code)

    def test_handback_truncatesPathList_whenManyEditsAreOutsideScope(self):
        uses = [("Write", {"file_path": os.path.join(self.sandbox.root, "elsewhere", "f%03d.py" % index)}) for index in range(500)]
        result = self.handback(PROVEN_REPORT, tool_uses=uses)
        self.assertEqual(2, result.code)
        self.assertLessEqual(len(result.stderr), 2000 + 1)
        self.assertIn("…and 490 more", result.stderr)


class HandbackReviewEvidenceTest(ReportGateTestCase):
    def test_handback_pipesEvidenceToCli_whenFirstLineIsVerdictPass(self):
        # when
        result = self.handback(PASS_REPORT)
        # then
        self.assertEqual(0, result.code)
        calls = self.sandbox.stub_calls("keel")
        self.assertEqual(1, len(calls))
        self.assertEqual(["evidence", "write-review"], calls[0]["argv"])
        request = json.loads(calls[0]["stdin"])
        self.assertEqual("PASS", request["verdict"])
        self.assertEqual("a" * 40, request["keel_evidence"]["review_base"])
        source = request["source"]
        self.assertEqual((SESSION_ID, AGENT_ID, "SubagentHandback"), (source["session_id"], source["agent_id"], source["via"]))
        self.assertTrue(source["agent_transcript_path"].endswith("/subagents/workflows/wf-1/agent-%s.jsonl" % AGENT_ID))
        self.assertEqual(self.sandbox.main_transcript(), source["transcript_path"])
        self.assertFired("K1", "record", "report-gate")

    def test_handback_sendsNeedsFixes_whenFirstLineIsVerdictNeedsFixes(self):
        self.handback(PASS_REPORT.replace("VERDICT: PASS", "VERDICT: NEEDS_FIXES", 1))
        self.assertEqual("NEEDS_FIXES", json.loads(self.sandbox.stub_calls("keel")[0]["stdin"])["verdict"])

    def test_handback_sendsOneRequestPerRepo_whenSeveralEvidenceLines(self):
        self.handback(PASS_REPORT + "\n" + EVIDENCE_LINE.replace("/work/app", "/work/lib"))
        self.assertEqual(2, len(self.sandbox.stub_calls("keel")))

    def test_handback_writesNothing_whenVerdictIsNotFirstLine(self):
        self.handback("Summary first.\n" + PASS_REPORT)
        self.assertEqual([], self.sandbox.stub_calls("keel"))

    def test_handback_warnsK1_whenCliRefuses(self):
        self.sandbox.env["KEEL_CLI"] = self.sandbox.stub("keel-refusing", exit_code=3)
        result = self.handback(PASS_REPORT)
        self.assertEqual(0, result.code)
        self.assertFired("K1", "warn", "report-gate")

    def test_handback_warnsK1_whenEvidenceLineIsNotJson(self):
        self.handback("VERDICT: PASS\n3 files changed\nKEEL-EVIDENCE: {not json}")
        self.assertEqual([], self.sandbox.stub_calls("keel"))
        self.assertFired("K1", "warn", "report-gate")

    def test_handback_warnsK1_whenAgentTranscriptMissing(self):
        self.handback(PASS_REPORT, with_transcript=False)
        self.assertEqual([], self.sandbox.stub_calls("keel"))
        self.assertFired("K1", "warn", "report-gate")

    # K1: a reviewer that edited is an author; its verdict writes no evidence
    def test_handback_refusesEvidence_whenReviewerUsedAnEditTool(self):
        # given a reviewer transcript with an Edit inside the scope
        result = self.handback(PASS_REPORT, tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        # then: the report passes, no evidence is written, the refusal is logged
        self.assertEqual(0, result.code)
        self.assertEqual([], self.sandbox.stub_calls("keel"))
        warns = self.assertFired("K1", "warn", "report-gate")
        self.assertTrue(warns[0]["detail"].startswith("reviewer-mutated"), warns)

    def test_handback_refusesEvidence_whenReviewerRanSedInPlaceOutsideScratch(self):
        self.handback(PASS_REPORT, tool_uses=[("Bash", {"command": "sed -i '' s/a/b/ %s/a.py" % self.scope})])
        self.assertEqual([], self.sandbox.stub_calls("keel"))
        self.assertFired("K1", "warn", "report-gate")

    def test_handback_writesEvidence_whenReviewerOnlyReadAndWroteUnderTmp(self):
        uses = [("Bash", {"command": "git diff --stat > /tmp/review-notes.txt"}),
                ("Bash", {"command": "keel snapshot %s" % self.scope}),
                ("Read", {"file_path": os.path.join(self.scope, "a.py")})]
        self.handback(PASS_REPORT, tool_uses=uses)
        self.assertEqual(1, len(self.sandbox.stub_calls("keel")))


class SubagentStopTest(ReportGateTestCase):
    def test_stop_blocksWithK2_whenMutatingAgentReportsWithoutEvidence(self):
        result = self.stop("Changed it.", tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        self.assertEqual(0, result.code)
        self.assertEqual("block", result.json()["decision"])
        self.assertIn("[K2]", result.json()["reason"])
        self.assertTrue(result.json()["reason"].startswith("[K2] report-gate: "))

    def test_stop_passes_whenStopHookActive(self):
        result = self.stop("Changed it.", tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})], stop_hook_active=True)
        self.assertEqual("", result.stdout)

    def test_stop_blocksWithK5_whenEditOutsideScope(self):
        result = self.stop(PROVEN_REPORT, tool_uses=[("Edit", {"file_path": "/elsewhere/x.py"})])
        self.assertIn("[K5]", result.json()["reason"])

    def test_stop_writesEvidenceViaStop_whenNoHandbackThisTurn(self):
        self.stop(PASS_REPORT)
        request = json.loads(self.sandbox.stub_calls("keel")[0]["stdin"])
        self.assertEqual("SubagentStop", request["source"]["via"])

    def test_stop_refusesEvidence_whenReviewerEdited(self):
        self.stop(PASS_REPORT, tool_uses=[("Write", {"file_path": os.path.join(self.scope, "a.py"), "content": "x"})])
        self.assertEqual([], self.sandbox.stub_calls("keel"))
        self.assertFired("K1", "warn", "report-gate")

    def test_stop_skipsJudgingAndWriting_whenReportWasHandedBackThisTurn(self):
        # given
        self.handback(PASS_REPORT)
        # when
        result = self.stop("Wrap-up: report delivered.", tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        # then
        self.assertEqual("", result.stdout)
        self.assertEqual(1, len(self.sandbox.stub_calls("keel")))

    def test_stop_judgesAgain_whenNextTurnHasNoHandback(self):
        self.handback(PASS_REPORT)
        self.stop("wrap-up")
        result = self.stop("Changed it.", tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        self.assertEqual("block", result.json()["decision"])

    def test_stop_passes_whenAgentEndedWithStructuredOutput(self):
        result = self.stop("ok", tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")}), ("StructuredOutput", {"x": 1})])
        self.assertEqual("", result.stdout)

    def test_stop_warnsK2AndLogsContractMiss_whenMutatingAgentLeftNoFinalText(self):
        result = self.stop(None, tool_uses=[("Edit", {"file_path": os.path.join(self.scope, "a.py")})])
        self.assertEqual("", result.stdout)
        self.assertFired("K2", "warn", "report-gate")
        miss, = self.contract_misses()
        self.assertIn("missing last_assistant_message;", miss["detail"])

    def test_stop_logsNoContractMiss_whenPayloadIsComplete(self):
        self.stop(PROVEN_REPORT)
        self.assertEqual([], self.contract_misses())

    def test_stop_passes_whenAgentTranscriptNeverWritten(self):
        result = self.stop("Changed it.", agent_transcript=os.path.join(self.sandbox.root, "missing.jsonl"))
        self.assertEqual("", result.stdout)
        self.assertEqual([], self.sandbox.fires())

    def test_stop_warnsK1_whenTranscriptNeverWrittenAndReportIsAReview(self):
        result = self.stop(PASS_REPORT, agent_transcript=os.path.join(self.sandbox.root, "missing.jsonl"))
        self.assertEqual("", result.stdout)
        self.assertEqual([], self.sandbox.stub_calls("keel"))
        self.assertFired("K1", "warn", "report-gate")

    def test_stop_passesAndLogsError_whenTranscriptUnreadable(self):
        unreadable = os.path.join(self.sandbox.root, "a-directory")
        os.makedirs(unreadable)
        result = self.stop("Changed it.", agent_transcript=unreadable)
        self.assertEqual(0, result.code)
        self.assertFired("K2", "error", "report-gate")

    def test_reportGate_passesAndLogsError_whenPayloadIsNotJson(self):
        self.assertEqual(0, self.sandbox.run_hook(REPORT_GATE, raw="not json").code)
        self.assertFired("K2", "error", "report-gate")


if __name__ == "__main__":
    unittest.main()
