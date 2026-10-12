"""The grading model without claude: asks heuristic, pass rules per case kind, faults, verdicts, config guard."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import unittest

from helpers import CHECKOUT

sys.path.insert(0, os.path.join(CHECKOUT, "measure", "evals", "lib"))
sys.path.insert(0, os.path.join(CHECKOUT, "measure", "lib"))

from evalkit.cases import AMBIGUOUS, CLEAR_ANSWER, CLEAR_CHANGE, Case  # noqa: E402
from evalkit.grade import fault_reason, run_passes, text_answers, text_asks  # noqa: E402
from evalkit.runner import QUESTION_PROTOCOL, claude_command  # noqa: E402
from evalkit.liveconfig import GENERATED_CLAUDE_MD_HEADER, is_keel_live, project_dir_for, suite_eval_id  # noqa: E402
from evalkit.stream import RunFacts, StreamSummary, summarize_stream  # noqa: E402
from evalkit.verdict import CaseVerdict, passes_needed, split_verdict, suite_passes  # noqa: E402

TIMEOUT = 300
AMBIGUOUS_CASE = Case("a1", "train", AMBIGUOUS, "-", "Improve this screen.")
CHANGE_CASE = Case("c1", "train", CLEAR_CHANGE, "-", "Rename x to y.")
ANSWER_CASE = Case("c2", "train", CLEAR_ANSWER, "grandTotalCents", "What does useCart return?")
MAX_TURNS = "error_max_turns"


def facts(changed: bool = False, ask_calls: int = 0, denied: tuple = (), text: str = "Done.", subtype: str = "success", is_error: bool = False,
          exit_code: int = 0, timed_out: bool = False, model_usage: bool = True, leftover: str = None, no_result: bool = False) -> RunFacts:
    result = None if no_result else {"subtype": subtype, "is_error": is_error, "result": text, "modelUsage": {"m": {"inputTokens": 1}} if model_usage else {}}
    stream = StreamSummary(init={"model": "m"}, result=result, ask_calls=ask_calls, skill_calls=[], denied_tools=list(denied))
    return RunFacts(stream=stream, exit_code=exit_code, timed_out=timed_out, changed=changed, leftover_project_dir=leftover)


class TextAsksTest(unittest.TestCase):
    def test_textAsks_true_whenALineStartsWithTheQuestionMarker(self) -> None:
        for reply in ("I looked at the screens.\n\nQUESTION: Which screen do you mean?",
                      "Two readings.\n- QUESTION: delete it or tidy it?\n\nNothing changed yet.",
                      "**QUESTION:** Which report?", "> QUESTION: which branch", "1. QUESTION: which screen?",
                      "2) QUESTION: which one?", "+ QUESTION: which?", "### QUESTION: which?", "> - QUESTION: which?",
                      "  QUESTION: which branch?", "**QUESTION**: which?", "__QUESTION__: which?", "__QUESTION:__ which?"):
            with self.subTest(reply=reply):
                self.assertTrue(text_asks(reply))

    def test_textAsks_true_whenThePromptRefineHeadingAppears(self) -> None:
        self.assertTrue(text_asks("## Refined request\nGoal: improve a screen\n\nI will wait for your pick."))

    def test_textAsks_false_withoutTheMarker_evenForAQuestionInProse(self) -> None:
        for reply in ("Which screen do you mean?", "Let me know which report you mean.", "The refined request is clear; I changed nothing.",
                      "Refined request: none needed, the target is clear."):
            with self.subTest(reply=reply):
                self.assertFalse(text_asks(reply))
                self.assertFalse(run_passes(AMBIGUOUS_CASE, facts(text=reply)))

    def test_textAsks_false_whenTheMarkerIsInsideAFenceOrMidLine(self) -> None:
        for reply in ("Example:\n\n```\nQUESTION: not a real one\n```", "I would write QUESTION: here but I will not."):
            with self.subTest(reply=reply):
                self.assertFalse(text_asks(reply))

    def test_textAsks_returnsQuickly_whenALineIsALongRunOfHashes(self) -> None:
        started = time.monotonic()
        self.assertFalse(text_asks("#" * 26 + " x"))  # Not `#+` in the repeated prefix group: it backtracks exponentially on this run
        self.assertLess(time.monotonic() - started, 1.0)

    def test_textAsks_false_whenNoFinalText(self) -> None:
        self.assertFalse(text_asks(None))


class TextAnswersTest(unittest.TestCase):
    def test_textAnswers_true_whenTheTokenIsOnALineThatIsNotAQuestion(self) -> None:
        self.assertTrue(text_answers("useCart returns lineItems, grandTotalCents and addItem.\n\nQUESTION: add a clear() too?", "grandTotalCents"))

    def test_textAnswers_false_whenTheTokenIsOnlyInTheOptionsUnderAQuestion(self) -> None:
        for reply in ("QUESTION: which field do you mean?\n- grandTotalCents\n- totalCents",
                      "QUESTION: which field do you mean?\n\n1. grandTotalCents\n2. totalCents",
                      "1. QUESTION: do you mean grandTotalCents?"):
            with self.subTest(reply=reply):
                self.assertFalse(text_answers(reply, "grandTotalCents"))
                self.assertFalse(run_passes(ANSWER_CASE, facts(text=reply)))

    def test_textAnswers_true_whenTheAnswerComesRightBeforeAFollowUpQuestion(self) -> None:
        self.assertTrue(text_answers("It returns grandTotalCents.\nQUESTION: want a clear() too?", "grandTotalCents"))

    def test_textAnswers_false_whenTheTokenIsOnlyInAQuestionLine(self) -> None:
        self.assertFalse(text_answers("QUESTION: do you mean grandTotalCents or totalCents?", "grandTotalCents"))

    def test_textAnswers_true_whenTokenIsInBackticksOrAnotherCase(self) -> None:
        self.assertTrue(text_answers("It returns `grandTotalCents` among others.", "grandTotalCents"))
        self.assertTrue(text_answers("GRANDTOTALCENTS is the total.", "grandTotalCents"))

    def test_textAnswers_false_whenTokenOnlyInsideAFence(self) -> None:
        self.assertFalse(text_answers("The hook body:\n\n```ts\nreturn { grandTotalCents };\n```\n\nThat is all.", "grandTotalCents"))

    def test_textAnswers_false_whenNoFinalText(self) -> None:
        self.assertFalse(text_answers(None, "4317"))


class QuestionProtocolTest(unittest.TestCase):
    def test_claudeCommand_appendsTheQuestionProtocol_naming_theMarker(self) -> None:
        command = claude_command("m")
        self.assertEqual(command[command.index("--append-system-prompt") + 1], QUESTION_PROTOCOL)
        self.assertIn("QUESTION:", QUESTION_PROTOCOL)
        self.assertTrue(text_asks("QUESTION: which one?"))


class AmbiguousGradeTest(unittest.TestCase):
    def test_ambiguous_passes_whenAskToolCalledAndNothingChanged(self) -> None:
        self.assertTrue(run_passes(AMBIGUOUS_CASE, facts(ask_calls=1)))

    def test_ambiguous_passes_whenAskToolDeniedAndNothingChanged(self) -> None:
        self.assertTrue(run_passes(AMBIGUOUS_CASE, facts(denied=("AskUserQuestion",))))

    def test_ambiguous_passes_whenFinalTextAsks_withoutTheAskTool(self) -> None:
        self.assertTrue(run_passes(AMBIGUOUS_CASE, facts(text="QUESTION: Which screen?")))

    def test_ambiguous_fails_whenAskedThenEdited(self) -> None:
        self.assertFalse(run_passes(AMBIGUOUS_CASE, facts(ask_calls=1, changed=True)))

    def test_ambiguous_fails_whenEditWasDenied_evenIfAsked(self) -> None:
        self.assertFalse(run_passes(AMBIGUOUS_CASE, facts(ask_calls=1, denied=("Edit",))))

    def test_ambiguous_fails_whenAnsweredWithoutAsking(self) -> None:
        self.assertFalse(run_passes(AMBIGUOUS_CASE, facts(text="I improved the dashboard.")))

    def test_ambiguous_passes_onMaxTurns_whenAskToolCalled(self) -> None:
        self.assertTrue(run_passes(AMBIGUOUS_CASE, facts(ask_calls=1, subtype=MAX_TURNS, is_error=True, exit_code=1)))

    def test_ambiguous_fails_onMaxTurns_withoutAskTool(self) -> None:
        self.assertFalse(run_passes(AMBIGUOUS_CASE, facts(text="QUESTION: Which screen?", subtype=MAX_TURNS, is_error=True, exit_code=1)))

    def test_ambiguous_ignoresLookupDenials(self) -> None:
        self.assertTrue(run_passes(AMBIGUOUS_CASE, facts(ask_calls=1, denied=("Read", "Grep"))))


class ClearChangeGradeTest(unittest.TestCase):
    def test_clearChange_passes_whenChangedWithoutAskTool(self) -> None:
        self.assertTrue(run_passes(CHANGE_CASE, facts(changed=True)))

    def test_clearChange_passes_whenChangedThenAskedInText(self) -> None:
        self.assertTrue(run_passes(CHANGE_CASE, facts(changed=True, text="Renamed it. Want a test too?")))

    def test_clearChange_fails_whenAskToolCalled_evenAfterTheEdit(self) -> None:
        self.assertFalse(run_passes(CHANGE_CASE, facts(changed=True, ask_calls=1)))

    def test_clearChange_fails_whenAskToolDenied(self) -> None:
        self.assertFalse(run_passes(CHANGE_CASE, facts(changed=True, denied=("AskUserQuestion",))))

    def test_clearChange_fails_whenEditDeniedAndNothingChanged(self) -> None:
        self.assertFalse(run_passes(CHANGE_CASE, facts(denied=("Edit",))))

    def test_clearChange_passes_onMaxTurns_whenChanged(self) -> None:
        self.assertTrue(run_passes(CHANGE_CASE, facts(changed=True, subtype=MAX_TURNS, is_error=True, exit_code=1)))


class ClearAnswerGradeTest(unittest.TestCase):
    def test_clearAnswer_passes_whenTokenAnsweredAndOfferFollows(self) -> None:
        self.assertTrue(run_passes(ANSWER_CASE, facts(text="It returns grandTotalCents.\n\nShall I document it?")))

    def test_clearAnswer_fails_whenQuestionEchoesTheToken(self) -> None:
        self.assertFalse(run_passes(ANSWER_CASE, facts(text="QUESTION: Do you mean grandTotalCents?")))

    def test_clearAnswer_fails_whenAnsweredButFilesChanged(self) -> None:
        self.assertFalse(run_passes(ANSWER_CASE, facts(text="It returns grandTotalCents.", changed=True)))

    def test_clearAnswer_fails_whenAnsweredButEditDenied(self) -> None:
        self.assertFalse(run_passes(ANSWER_CASE, facts(text="It returns grandTotalCents.", denied=("Write",))))

    def test_clearAnswer_fails_whenAskToolCalled(self) -> None:
        self.assertFalse(run_passes(ANSWER_CASE, facts(text="It returns grandTotalCents.", ask_calls=1)))

    def test_clearAnswer_fails_onMaxTurns_becauseThereIsNoFinalText(self) -> None:
        self.assertFalse(run_passes(ANSWER_CASE, facts(text="It returns grandTotalCents.", subtype=MAX_TURNS, is_error=True, exit_code=1)))


class SummarizeStreamTest(unittest.TestCase):
    @staticmethod
    def assistant(name: str, tool_input: dict, parent: str = None) -> str:
        return '{"type":"assistant","parent_tool_use_id":%s,"message":{"content":[{"type":"tool_use","name":"%s","input":%s}]}}' % (
            '"%s"' % parent if parent else "null", name, __import__("json").dumps(tool_input))

    def test_summarizeStream_countsAskCalls_inTheMainConversationOnly(self) -> None:
        summary = summarize_stream([self.assistant("AskUserQuestion", {}), self.assistant("AskUserQuestion", {}, parent="toolu_1")])
        self.assertEqual(summary.ask_calls, 1)

    def test_summarizeStream_recordsBareSkillName_forPluginSpelling(self) -> None:
        summary = summarize_stream([self.assistant("Skill", {"skill": "plug:prompt-refine"}), self.assistant("Read", {"skill": "prompt-refine"})])
        self.assertEqual(summary.skill_calls, ["prompt-refine"])

    def test_summarizeStream_skipsNonJsonLines(self) -> None:
        summary = summarize_stream(["[verbose] starting", self.assistant("AskUserQuestion", {}), ""])
        self.assertEqual(summary.ask_calls, 1)

    def test_summarizeStream_keepsInitAndResultAndDeniedTools(self) -> None:
        lines = ['{"type":"system","subtype":"init","model":"m1"}', '{"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{"m1":{}},"permission_denials":[{"tool_name":"Edit"},{"tool_name":"Bash"}]}']
        summary = summarize_stream(lines)
        self.assertEqual((summary.init["model"], summary.result["result"], summary.denied_tools), ("m1", "ok", ["Edit", "Bash"]))


class FaultTest(unittest.TestCase):
    def test_fault_whenTimedOut(self) -> None:
        self.assertIn("timed out", fault_reason(facts(timed_out=True, no_result=True, exit_code=124), TIMEOUT))

    def test_fault_whenNoResultEvent(self) -> None:
        self.assertEqual(fault_reason(facts(no_result=True), TIMEOUT), "no result event")

    def test_fault_whenLoggedOutShape_exitOneSuccessIsErrorEmptyModelUsage(self) -> None:
        self.assertIn("logged out", fault_reason(facts(exit_code=1, is_error=True, model_usage=False, text="Not logged in"), TIMEOUT))

    def test_fault_whenOnlyIsErrorIsSetOnASuccessResult(self) -> None:
        self.assertEqual(fault_reason(facts(is_error=True), TIMEOUT), "result has is_error with subtype success (logged out?)")

    def test_fault_whenModelUsageEmpty_evenWithACleanResult(self) -> None:
        self.assertIn("modelUsage", fault_reason(facts(model_usage=False), TIMEOUT))

    def test_fault_whenExitNonZero_withASuccessResult(self) -> None:
        self.assertIn("exit 1", fault_reason(facts(exit_code=1), TIMEOUT))

    def test_noFault_whenExitNonZero_onMaxTurns(self) -> None:
        self.assertIsNone(fault_reason(facts(exit_code=1, subtype=MAX_TURNS, is_error=True), TIMEOUT))

    def test_fault_whenAToolOutsideTheGradedSetIsDenied(self) -> None:
        self.assertEqual(fault_reason(facts(denied=("Edit", "Bash")), TIMEOUT), "permission denied for Bash")

    def test_noFault_whenOnlyGradedOrLookupToolsAreDenied(self) -> None:
        self.assertIsNone(fault_reason(facts(denied=("Edit", "Write", "AskUserQuestion", "Read", "Grep", "Glob")), TIMEOUT))

    def test_fault_whenAProjectDirectoryWasLeftBehind(self) -> None:
        self.assertIn("/cfg/projects/-tmp-x", fault_reason(facts(leftover="/cfg/projects/-tmp-x"), TIMEOUT))

    def test_noFault_onACleanRun(self) -> None:
        self.assertIsNone(fault_reason(facts(), TIMEOUT))


class VerdictTest(unittest.TestCase):
    def test_passesNeeded_isTwoThirdsRoundedUp(self) -> None:
        self.assertEqual([passes_needed(n) for n in (1, 2, 3, 4, 6)], [1, 2, 2, 3, 4])

    def test_caseVerdict_passes_withTwoOfThreeRuns_andFailsWithOne(self) -> None:
        self.assertTrue(CaseVerdict(AMBIGUOUS_CASE, [True, False, True]).passed)
        self.assertFalse(CaseVerdict(AMBIGUOUS_CASE, [True, False, False]).passed)

    def test_splitVerdict_fails_whenAnyClearCaseFails(self) -> None:
        verdicts = [CaseVerdict(AMBIGUOUS_CASE, [True]), CaseVerdict(CHANGE_CASE, [False]), CaseVerdict(ANSWER_CASE, [True])]
        self.assertFalse(split_verdict("train", verdicts).passed)

    def test_splitVerdict_passes_withTwoThirdsOfAmbiguousCases_andFailsBelow(self) -> None:
        ambiguous = [Case("a%d" % n, "train", AMBIGUOUS, "-", "p") for n in range(3)]
        two_of_three = [CaseVerdict(case, [passed]) for case, passed in zip(ambiguous, (True, True, False))] + [CaseVerdict(CHANGE_CASE, [True])]
        one_of_three = [CaseVerdict(case, [passed]) for case, passed in zip(ambiguous, (True, False, False))] + [CaseVerdict(CHANGE_CASE, [True])]
        self.assertTrue(split_verdict("train", two_of_three).passed)
        self.assertFalse(split_verdict("train", one_of_three).passed)

    def test_splitVerdict_countsOnlyItsOwnSplit(self) -> None:
        holdout = Case("h1", "holdout", CLEAR_CHANGE, "-", "p")
        verdict = split_verdict("holdout", [CaseVerdict(CHANGE_CASE, [False]), CaseVerdict(holdout, [True])])
        self.assertEqual((verdict.cases, verdict.passed_cases, verdict.passed), (1, 1, True))

    def test_suitePasses_onlyWhenBothSplitsPass(self) -> None:
        passing = split_verdict("train", [CaseVerdict(AMBIGUOUS_CASE, [True]), CaseVerdict(CHANGE_CASE, [True])])
        failing = split_verdict("train", [CaseVerdict(AMBIGUOUS_CASE, [False]), CaseVerdict(CHANGE_CASE, [True])])
        self.assertTrue(suite_passes([passing, passing]))
        self.assertFalse(suite_passes([passing, failing]))


class LiveConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="keel-eval-cfg-"))
        self.keel = os.path.join(self.root, "keel")
        self.config = os.path.join(self.root, "config")
        os.makedirs(os.path.join(self.keel, "skills", "prompt-refine"))
        os.makedirs(os.path.join(self.config, "skills"))

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def link_skill(self) -> None:
        os.symlink(os.path.join(self.keel, "skills", "prompt-refine"), os.path.join(self.config, "skills", "prompt-refine"))

    def write_claude_md(self, first_line: str) -> None:
        with open(os.path.join(self.config, "CLAUDE.md"), "w", encoding="utf-8") as handle:
            handle.write(first_line + "\n# Principles\n")

    def test_projectDirFor_slugsTheRealpath_withEveryNonAlphanumericAsDash(self) -> None:
        link = os.path.join(self.root, "work-link")
        os.symlink(self.keel, link)
        self.assertEqual(project_dir_for(link, "/cfg"), "/cfg/projects/" + self.keel.replace("/", "-").replace("_", "-").replace(".", "-"))

    def test_isKeelLive_true_whenSkillLinkedIntoKeelAndClaudeMdGenerated(self) -> None:
        self.link_skill()
        self.write_claude_md(GENERATED_CLAUDE_MD_HEADER)
        self.assertTrue(is_keel_live(self.config, self.keel, "prompt-refine"))

    def test_isKeelLive_false_whenSkillIsARealDirectory(self) -> None:
        os.makedirs(os.path.join(self.config, "skills", "prompt-refine"))
        self.write_claude_md(GENERATED_CLAUDE_MD_HEADER)
        self.assertFalse(is_keel_live(self.config, self.keel, "prompt-refine"))

    def test_isKeelLive_false_whenClaudeMdIsNotGenerated(self) -> None:
        self.link_skill()
        self.write_claude_md("# My own CLAUDE.md")
        self.assertFalse(is_keel_live(self.config, self.keel, "prompt-refine"))

    def test_isKeelLive_true_whenConfigDirAndKeelHomeAreReachedThroughSymlinks(self) -> None:
        self.link_skill()
        self.write_claude_md(GENERATED_CLAUDE_MD_HEADER)
        config_alias, keel_alias = os.path.join(self.root, "dot-claude"), os.path.join(self.root, "keel-alias")
        os.symlink(self.config, config_alias)
        os.symlink(self.keel, keel_alias)
        self.assertTrue(is_keel_live(config_alias, keel_alias, "prompt-refine"))

    def test_suiteEvalId_addsBaselineSuffix_whenKeelIsNotLive(self) -> None:
        self.assertEqual((suite_eval_id("K4", True), suite_eval_id("K4", False)), ("K4", "K4-v1baseline"))


if __name__ == "__main__":
    unittest.main()
