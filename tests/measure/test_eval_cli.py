"""measure/evals/eval end to end against the stub claude: what it writes, when it refuses, and what it hands claude."""
from __future__ import annotations

import json
import os
import sys
import unittest

from helpers import CHECKOUT, read_text

sys.path.insert(0, os.path.join(CHECKOUT, "measure", "evals", "lib"))
sys.path.insert(0, os.path.join(CHECKOUT, "measure", "lib"))

from eval_helpers import ASK_EVENT, ASK_TEXT, EDIT_EVENT, MODEL, EvalSandbox, case_row, init_event, read_json, read_jsonl, result_event, tool_use  # noqa: E402
from evalkit.grade import grader_commit  # noqa: E402

RUN_ONCE = ("--repeat", "1")


class EvalCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = EvalSandbox()

    def tearDown(self) -> None:
        self.box.cleanup()

    def eval_ids(self) -> list:
        return [line["eval_id"] for line in self.box.eval_lines()]

    def test_fullRun_writesK4SuiteLineAndCaseLines_whenKeelIsLinked(self) -> None:
        # given
        self.box.link_keel()
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        # when
        completed, report = self.box.run_eval_json("K4", "--model", "requested-model", *RUN_ONCE)
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((report["eval_id"], report["pass"], report["written"], report["model"]), ("K4", True, True, MODEL))
        suite = [line for line in self.box.eval_lines() if line["eval_id"] == "K4"]
        self.assertEqual(suite, [{"ts": suite[0]["ts"], "eval_id": "K4", "rule_id": "K4", "case": "suite train=2/2 holdout=2/2", "pass": True, "model": MODEL}])
        cases = [(line["case"], line["pass"]) for line in self.box.eval_lines() if line["eval_id"] == "K4.case"]
        self.assertEqual(cases, [("a1", True), ("c1", True), ("h1", True), ("h2", True)])

    def test_fullRun_writesV1BaselineLine_whenKeelIsNotLinked(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE)
        # then
        self.assertEqual((completed.returncode, report["eval_id"]), (0, "K4-v1baseline"), completed.stderr)
        self.assertEqual(self.eval_ids().count("K4"), 0)
        self.assertEqual(self.eval_ids().count("K4-v1baseline"), 1)

    def test_fullRun_writesAFailingSuiteLine_whenAClearCaseFails(self) -> None:
        # given
        self.box.link_keel()
        silent = self.box.scenario("silent", [init_event(), result_event("I would rename it, but which one?")])
        self.box.seed_suite(self.box.ask_scenario(), silent)
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE)
        # then
        self.assertEqual((completed.returncode, report["pass"], report["written"]), (1, False, True), completed.stderr)
        self.assertEqual([line["pass"] for line in self.box.eval_lines() if line["eval_id"] == "K4"], [False])

    def test_fullRun_passesACaseWithTwoOfThreeRuns_andTwoThirdsOfAmbiguousCases(self) -> None:
        # given
        self.box.link_keel()
        ask, silent = self.box.round([init_event(), ASK_EVENT, result_event(ASK_TEXT)]), self.box.round([init_event(), result_event("Done, I guessed.")])
        two_of_three = self.box.scenario("two", rounds=[ask, ask, silent])
        one_of_three = self.box.scenario("one", rounds=[ask, silent, silent])
        self.box.write_cases("keel/measure/evals/K4/train.tsv", [
            case_row("a1", "ambiguous", two_of_three), case_row("a2", "ambiguous", one_of_three), case_row("a3", "ambiguous", two_of_three),
            case_row("c1", "clear-change", self.box.edit_scenario()),
        ])
        self.box.write_cases("keel/measure/evals/K4/holdout.tsv", [case_row("h1", "ambiguous", two_of_three), case_row("h2", "clear-change", "edit")])
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL)
        # then
        self.assertEqual((completed.returncode, report["pass"]), (0, True), completed.stderr)
        by_case = {case["id"]: (case["runs"], case["pass"]) for case in report["cases"]}
        self.assertEqual(by_case["a1"], ([True, True, False], True))
        self.assertEqual(by_case["a2"], ([True, False, False], False))
        self.assertEqual(report["splits"]["train"], {"cases": 4, "passed": 3, "pass": True})
        self.assertEqual([line["pass"] for line in self.box.eval_lines() if line["case"] == "a2"], [False])

    def test_fullRun_handsClaudeTheDesignedCommand_promptOnStdin_inAFreshTempRepo(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        # when
        self.box.run_eval("K4", "--model", "pinned", *RUN_ONCE)
        # then
        call = self.box.stub_calls()[0]
        argv = " ".join(call["argv"])
        self.assertIn("-p --model pinned --output-format stream-json --verbose --settings {\"disableAllHooks\":true}", argv)
        self.assertIn("--tools Skill,Read,Grep,Glob,Edit,Write,AskUserQuestion --disallowedTools Bash,NotebookEdit,Agent,Task,Workflow,WebFetch,WebSearch", argv)
        self.assertIn("--permission-mode acceptEdits --strict-mcp-config --max-turns 8 --no-session-persistence", argv)
        self.assertEqual((call["scenario"], call["auto_memory_disabled"]), ("ask", "1"))
        self.assertFalse(call["cwd"].startswith(self.box.root), call["cwd"])
        self.assertFalse(os.path.exists(call["cwd"]), "the temp repo is removed after the run")

    def test_subsetRun_writesPartialAndCaseLines_neverK4(self) -> None:
        # given
        self.box.link_keel()
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        for selection in (("--case", "c1"), ("--split", "train")):
            # when
            completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, *selection)
            # then
            self.assertEqual((completed.returncode, report["eval_id"], report["pass"]), (0, "K4-partial", True), completed.stderr)
        self.assertEqual(self.eval_ids().count("K4"), 0)
        self.assertEqual(self.eval_ids().count("K4-partial"), 2)
        self.assertEqual([line["case"] for line in self.box.eval_lines() if line["eval_id"] == "K4-partial"], ["subset train=1/1 holdout=0/0", "subset train=2/2 holdout=0/0"])
        self.assertEqual([line["case"] for line in self.box.eval_lines() if line["eval_id"] == "K4.case"], ["c1", "a1", "c1"])

    def test_measureRunK4_countsOnlyFullRunLines(self) -> None:
        # given
        self.box.link_keel()
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        self.box.run_eval("K4", "--model", MODEL, *RUN_ONCE, "--case", "a1")
        _, before = self.box.run_json("run", "K4")
        # when
        self.box.run_eval("K4", "--model", MODEL, *RUN_ONCE)
        _, after = self.box.run_json("run", "K4")
        # then
        self.assertEqual((before["count"], after["count"], after["status"]), (0, 1, "PASS"))

    def test_clearChange_passes_whenAFileIsWrittenWithoutAnEditToolUse(self) -> None:
        # given
        self.box.link_keel()
        quiet_write = self.box.scenario("quiet-write", [init_event(), result_event("Added it.")], writes={"src/new.ts": "export {};\n"})
        self.box.seed_suite(self.box.ask_scenario(), quiet_write)
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE)
        # then
        self.assertEqual((completed.returncode, report["pass"]), (0, True), completed.stderr)
        self.assertIn("src/new.ts", read_text(os.path.join(report["raw_dir"], "c1-1.diff")))

    def test_run_ignoresWritesUnderDotClaude(self) -> None:
        # given
        self.box.link_keel()
        ask_and_settings = self.box.scenario("ask-settings", [init_event(), ASK_EVENT, result_event(ASK_TEXT)], writes={".claude/settings.local.json": "{}"})
        only_settings = self.box.scenario("only-settings", [init_event(), EDIT_EVENT, result_event("Done.")], writes={".claude/settings.local.json": "{}"})
        self.box.seed_suite(ask_and_settings, only_settings)
        # when
        _, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE)
        # then
        by_case = {case["id"]: case["pass"] for case in report["cases"]}
        self.assertEqual((by_case["a1"], by_case["c1"]), (True, False))

    def test_fault_loggedOutShape_exitsOneAndWritesNoEvalLine(self) -> None:
        # given
        self.box.link_keel()
        logged_out = self.box.scenario("logged-out", [init_event(), result_event("Not logged in", is_error=True, model_usage=False)], exit_code=1)
        self.box.seed_suite(self.box.ask_scenario(), logged_out)
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE)
        # then
        self.assertEqual((completed.returncode, report["pass"], report["written"]), (1, None, False), completed.stderr)
        self.assertEqual([(fault["case"], fault["run"]) for fault in report["faults"]], [("c1", 1), ("h2", 1)])
        self.assertIn("logged out", report["faults"][0]["reason"])
        self.assertEqual(self.box.eval_lines(), [])
        runs = read_jsonl(os.path.join(report["raw_dir"], "runs.jsonl"))
        self.assertEqual([run["fault"] is not None for run in runs], [False, True, False, True])
        self.assertTrue(os.path.exists(os.path.join(report["raw_dir"], "c1-1.stream.jsonl")))

    def test_fault_whenClaudeExceedsTheTimeout(self) -> None:
        # given
        slow = self.box.scenario("slow", [init_event(), result_event("late")], sleep=3)
        self.box.seed_suite(self.box.ask_scenario(), slow)
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, "--case", "c1", "--timeout-seconds", "1")
        # then
        self.assertEqual((completed.returncode, report["written"]), (1, False), completed.stderr)
        self.assertIn("timed out after 1s", report["faults"][0]["reason"])

    def test_fault_whenNoResultEventArrives(self) -> None:
        # given
        no_result = self.box.scenario("no-result", [init_event(), ASK_EVENT])
        self.box.seed_suite(no_result, self.box.edit_scenario())
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, "--case", "a1")
        # then
        self.assertEqual((completed.returncode, report["faults"][0]["reason"]), (1, "no result event"), completed.stderr)
        self.assertEqual(self.box.eval_lines(), [])

    def test_fault_whenTheSessionLeavesAProjectDirectoryUnderTheConfigDir(self) -> None:
        # given
        leaves = self.box.scenario("leaves", [init_event(), ASK_EVENT, result_event(ASK_TEXT)], leave_project_dir=True)
        self.box.seed_suite(leaves, self.box.edit_scenario())
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, "--case", "a1")
        # then
        self.assertEqual(completed.returncode, 1, completed.stderr)
        reason = report["faults"][0]["reason"]
        self.assertIn("project directory", reason)
        self.assertIn(os.path.join(self.box.data, "projects", "-"), reason, "the slug of an absolute realpath starts with '-'")

    def test_fault_whenAToolOutsideTheGradedSetIsDenied(self) -> None:
        # given
        bash_denied = self.box.scenario("bash-denied", [init_event(), ASK_EVENT, result_event(ASK_TEXT, denials=("Bash",))])
        self.box.seed_suite(bash_denied, self.box.edit_scenario())
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, "--case", "a1")
        # then
        self.assertEqual((completed.returncode, report["faults"][0]["reason"]), (1, "permission denied for Bash"), completed.stderr)

    def test_exitTwo_whenACaseIdRepeatsAcrossKeelAndOverlayFiles(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        self.box.write_cases("overlay/measure/evals/K4/train.tsv", [case_row("a1", "ambiguous", "ask")])
        # when
        completed = self.box.run_eval("K4", "--model", MODEL)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("duplicate case id 'a1'", completed.stderr)
        self.assertEqual((self.box.stub_calls(), self.box.eval_lines()), ([], []))

    def test_exitTwo_whenNoCaseIsSelected(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        # when
        completed = self.box.run_eval("K4", "--model", MODEL, "--case", "nope")
        # then
        self.assertEqual((completed.returncode, completed.stdout), (2, ""))
        self.assertIn("no case selected", completed.stderr)
        self.assertEqual(self.box.stub_calls(), [])

    def test_exitTwo_whenAFullRunSplitLacksAnAmbiguousOrClearCase(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        self.box.write_cases("keel/measure/evals/K4/holdout.tsv", [case_row("h2", "clear-change", "edit")])
        # when
        completed = self.box.run_eval("K4", "--model", MODEL)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("holdout has no ambiguous case", completed.stderr)
        self.assertEqual((self.box.stub_calls(), self.box.eval_lines()), ([], []))

    def test_exitTwo_whenTheLedgerHasNoRowForTheEvalId(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        # when
        completed = self.box.run_eval("K9", "--model", MODEL)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("no ledger row with id 'K9'", completed.stderr)

    def test_ambiguousRun_passes_whenTheFinalTextCarriesAQuestionLine(self) -> None:
        # given
        marked = self.box.scenario("marked", [init_event(), result_event("Two screens fit.\n\nQUESTION: Which screen do you mean?")])
        self.box.seed_suite(marked, self.box.edit_scenario())
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, "--case", "a1")
        # then
        self.assertEqual((completed.returncode, report["cases"][0]["runs"]), (0, [True]), completed.stderr)

    def test_exitTwo_whenACaseFileHasAnUnknownKind(self) -> None:
        # given
        self.box.write_cases("keel/measure/evals/K4/train.tsv", [case_row("a1", "vague", "ask")])
        # when
        completed = self.box.run_eval("K4", "--model", MODEL)
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unknown kind 'vague'", completed.stderr)

    def test_dryRun_printsThePlanAndCommand_andSpendsNothing(self) -> None:
        # given
        self.box.link_keel()
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        # when
        completed, plan = self.box.run_eval_json("K4", "--model", MODEL, "--dry-run")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((plan["eval_id"], plan["runs"], plan["keel_live"]), ("K4", 12, True))
        self.assertEqual([case["id"] for case in plan["cases"]], ["a1", "c1", "h1", "h2"])
        self.assertEqual(plan["command"][:4], ["claude", "-p", "--model", MODEL])
        self.assertNotIn("ask", json.dumps(plan["cases"]), "prompts never reach stdout")
        self.assertEqual((self.box.stub_calls(), self.box.eval_lines(), self.box.raw_dirs()), ([], [], []))

    def test_fault_beforeAnyRun_whenTheCliConfigDirDiffersFromTheDataDir(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        self.box.env["CLAUDE_CONFIG_DIR"] = os.path.join(self.box.root, "home", ".claude")
        # when
        completed, report = self.box.run_eval_json("K4", "--model", MODEL)
        # then
        self.assertEqual((completed.returncode, report["written"]), (1, False), completed.stderr)
        self.assertIn("differs from KEEL_DATA_DIR", report["faults"][0]["reason"])
        self.assertEqual(self.box.stub_calls(), [])

    def test_rawDir_holdsConfigStreamDiffFinalTextAndSkillDiagnostic(self) -> None:
        # given
        self.box.link_keel()
        fires = self.box.scenario("fires", [init_event(), tool_use("Skill", {"skill": "prompt-refine"}), ASK_EVENT, result_event(ASK_TEXT)])
        self.box.seed_suite(fires, self.box.edit_scenario())
        # when
        _, report = self.box.run_eval_json("K4", "--model", "pinned", *RUN_ONCE)
        # then
        raw = report["raw_dir"]
        config = read_json(os.path.join(raw, "config.json"))
        self.assertEqual((config["summary_eval_id"], config["model_requested"], config["model_observed"], config["cli_version"]), ("K4", "pinned", MODEL, "2.1.296"))
        self.assertEqual(len(config["claude_md_sha256"]), 64)
        self.assertEqual(len(config["skill_md_sha256"]), 64)
        self.assertEqual(read_text(os.path.join(raw, "a1-1.final.txt")), ASK_TEXT)
        self.assertEqual(read_json(os.path.join(raw, "skill-diagnostic.json")), {"skill": "prompt-refine", "ambiguous_runs": 2, "ambiguous_fired": 2, "clear_runs": 2, "clear_false_fires": 0})
        self.assertEqual(report["skill"]["ambiguous_fired"], 2)
        self.assertEqual(sorted(name for name in os.listdir(raw) if name.startswith("c1-1")), ["c1-1.diff", "c1-1.final.txt", "c1-1.stream.jsonl"])

    def suite_runs(self, change_denials: tuple = ()) -> list:
        """One run per case of seed_suite's four cases; the clear-change runs edit, the ambiguous ones ask."""
        ask = [init_event(), ASK_EVENT, result_event(ASK_TEXT)]
        edit = [init_event(), EDIT_EVENT, result_event("Renamed it.", denials=change_denials)]
        return [{"case": "a1", "kind": "ambiguous", "events": ask}, {"case": "c1", "kind": "clear-change", "events": edit, "changed": True},
                {"case": "h1", "kind": "ambiguous", "events": ask}, {"case": "h2", "kind": "clear-change", "events": edit, "changed": True}]

    def test_regrade_writesTheSuiteLineWithTheCurrentGrader_andCallsNoClaude(self) -> None:
        # given: a full run the old grader faulted because the candidate's Skill call was denied
        self.box.seed_suite("unused", "unused")
        runs = self.suite_runs(change_denials=("Skill",))
        runs[1]["fault"] = "permission denied for Skill"
        raw = self.box.write_raw_dir("K4-old", runs)
        # when
        completed, report = self.box.run_eval_json("K4", "--regrade", raw)
        # then
        self.assertEqual((completed.returncode, report["eval_id"], report["pass"], report["written"], report["faults"]), (0, "K4", True, True, []), completed.stderr)
        self.assertEqual(self.box.stub_calls(), [])
        self.assertEqual(report["leftover_unknown"], ["c1-1"], "the old Skill fault stopped the grader before its leftover check")
        suite = [line for line in self.box.eval_lines() if line["eval_id"] == "K4"]
        self.assertEqual(suite, [{"ts": suite[0]["ts"], "eval_id": "K4", "rule_id": "K4", "case": "suite train=2/2 holdout=2/2", "pass": True,
                                  "model": MODEL, "regraded_from": "keel-eval-K4-old", "grader": grader_commit(CHECKOUT)}])
        self.assertEqual([(line["case"], line["regraded_from"]) for line in self.box.eval_lines() if line["eval_id"] == "K4.case"],
                         [(case, "keel-eval-K4-old") for case in ("a1", "c1", "h1", "h2")])

    def test_regrade_matchesTheRunThatWroteTheRawDir(self) -> None:
        # given
        self.box.link_keel()
        silent = self.box.scenario("silent", [init_event(), result_event("I would rename it, but which one?")])
        self.box.seed_suite(self.box.ask_scenario(), silent)
        _, run_report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE)
        calls = len(self.box.stub_calls())
        # when
        completed, report = self.box.run_eval_json("K4", "--regrade", run_report["raw_dir"])
        # then
        self.assertEqual((completed.returncode, report["eval_id"], report["cases"]), (1, "K4", run_report["cases"]), completed.stderr)
        self.assertEqual(len(self.box.stub_calls()), calls)
        self.assertTrue(all("leftover_project_dir" in run for run in read_jsonl(os.path.join(run_report["raw_dir"], "runs.jsonl"))))

    def test_regrade_keepsATimeoutFault_withTheRunsTimeout(self) -> None:
        # given
        slow = self.box.scenario("slow", [init_event(), result_event("late")], sleep=3)
        self.box.seed_suite(self.box.ask_scenario(), slow)
        _, run_report = self.box.run_eval_json("K4", "--model", MODEL, *RUN_ONCE, "--case", "c1", "--timeout-seconds", "1")
        # when
        completed, report = self.box.run_eval_json("K4", "--regrade", run_report["raw_dir"])
        # then
        self.assertEqual((completed.returncode, report["written"], report["faults"][0]["reason"]), (1, False, "timed out after 1s"), completed.stderr)

    def test_regrade_writesPartial_whenTheRawDirIsNotAFullRunOfTheCurrentCases(self) -> None:
        moved_h1 = ([case_row("a1", "ambiguous", "u"), case_row("c1", "clear-change", "u"), case_row("h1", "ambiguous", "u")], [case_row("h2", "clear-change", "u")])
        joined_a9 = ([case_row("a1", "ambiguous", "u"), case_row("c1", "clear-change", "u"), case_row("a9", "ambiguous", "u")],
                     [case_row("h1", "ambiguous", "u"), case_row("h2", "clear-change", "u")])
        variants = {"short-of-runs": ({"repeat": 2}, None), "subset-summary": ({"summary_eval_id": "K4-partial"}, None),
                    "case-joined": ({}, joined_a9), "split-gap": ({}, moved_h1)}
        for name, (raw_options, case_files) in variants.items():
            with self.subTest(name):
                # given
                self.box.seed_suite("unused", "unused")
                if case_files:
                    self.box.write_cases("keel/measure/evals/K4/train.tsv", case_files[0])
                    self.box.write_cases("keel/measure/evals/K4/holdout.tsv", case_files[1])
                raw = self.box.write_raw_dir("K4-" + name, self.suite_runs(), **raw_options)
                # when
                completed, report = self.box.run_eval_json("K4", "--regrade", raw)
                # then
                self.assertEqual((completed.returncode, report["eval_id"]), (0, "K4-partial"), completed.stderr)
        self.assertEqual(self.eval_ids().count("K4"), 0)

    def test_regrade_writesNoCaseLine_forACaseWithoutASavedRun(self) -> None:
        # given: an interrupted run whose config names four cases but saved runs of two
        self.box.seed_suite("unused", "unused")
        raw = self.box.write_raw_dir("K4-interrupted", self.suite_runs()[:2], cases=["a1", "c1", "h1", "h2"])
        # when
        completed, report = self.box.run_eval_json("K4", "--regrade", raw)
        # then
        self.assertEqual((completed.returncode, report["eval_id"]), (0, "K4-partial"), completed.stderr)
        self.assertEqual([line["case"] for line in self.box.eval_lines() if line["eval_id"] == "K4.case"], ["a1", "c1"])

    def test_regrade_faults_whenTheRecordNamesALeftoverProjectDir(self) -> None:
        for name, run_fields in {"recorded": {"leftover": "/cfg/projects/-tmp-x"},
                                 "older-record": {"fault": "session left a project directory behind: /cfg/projects/-tmp-x"}}.items():
            with self.subTest(name):
                # given
                self.box.seed_suite("unused", "unused")
                runs = self.suite_runs()
                runs[0].update(run_fields)
                raw = self.box.write_raw_dir("K4-leftover-" + name, runs)
                # when
                completed, report = self.box.run_eval_json("K4", "--regrade", raw)
                # then
                self.assertEqual((completed.returncode, report["written"], report["faults"][0]["case"]), (1, False, "a1"), completed.stderr)
        self.assertEqual(self.box.eval_lines(), [])

    def test_regrade_exitsTwo_whenTheRawDirDoesNotMatchTheCaseFilesOrIsUnreadable(self) -> None:
        def kind_changed(runs):
            runs[0]["kind"] = "clear-answer"
            return {}
        variants = {
            "kind-changed": ("a1", kind_changed),
            "case-removed": ("z9", lambda runs: runs.append({"case": "z9", "kind": "ambiguous", "events": []}) or {}),
            "other-eval": ("K5", lambda runs: {"eval_id": "K5"}),
            "stray-run": ("c1", lambda runs: {"cases": ["a1", "h1", "h2"]}),
        }
        for name, (named, change) in variants.items():
            with self.subTest(name):
                # given
                self.box.seed_suite("unused", "unused")
                runs = self.suite_runs()
                raw = self.box.write_raw_dir("K4-" + name, runs, **change(runs))
                # when
                completed = self.box.run_eval("K4", "--regrade", raw)
                # then
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertIn(named, completed.stderr)
        for name, damage in {"no-runs-file": lambda path: os.remove(path), "malformed-line": lambda path: open(path, "a").write("{oops\n")}.items():
            with self.subTest(name):
                raw = self.box.write_raw_dir("K4-" + name, self.suite_runs())
                damage(os.path.join(raw, "runs.jsonl"))
                completed = self.box.run_eval("K4", "--regrade", raw)
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertIn("runs.jsonl", completed.stderr)
        self.assertEqual(self.box.eval_lines(), [])

    def test_exitTwo_whenRegradeIsMixedWithARunOption_orARunLacksAModel(self) -> None:
        # given
        self.box.seed_suite(self.box.ask_scenario(), self.box.edit_scenario())
        raw = self.box.write_raw_dir("K4-mixed", self.suite_runs())
        for args in (("K4", "--regrade", raw, "--case", "a1"), ("K4", "--regrade", raw, "--model", MODEL), ("K4",)):
            with self.subTest(args):
                # when
                completed = self.box.run_eval(*args)
                # then
                self.assertEqual(completed.returncode, 2, completed.stderr)
        self.assertEqual((self.box.eval_lines(), self.box.stub_calls()), ([], []))

if __name__ == "__main__":
    unittest.main()
