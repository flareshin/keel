from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import shutil
import tempfile
import unittest

from helpers import CHECKOUT, MeasureSandbox

sys.path.insert(0, os.path.join(CHECKOUT, "measure", "evals", "lib"))
sys.path.insert(0, os.path.join(CHECKOUT, "measure", "lib"))

from evalkit.cases import CaseError  # noqa: E402
from evalkit.reviewcases import load_review_cases  # noqa: E402
from evalkit.reviewgrade import grade_result, suite_numbers  # noqa: E402
from evalkit.reviewrun import BuildError, build_case_repo  # noqa: E402
from measurekit.gitutil import run_git  # noqa: E402

REVIEW_EVAL = os.path.join(CHECKOUT, "measure", "evals", "review-eval")
REVIEW_STUB_DIR = os.path.join(CHECKOUT, "tests", "measure", "stubs", "review")
CASES = os.path.join("measure", "evals", "review", "cases")
BASE_TEXT = "def total(items):\n    return sum(items)\n"
CHANGE = (
    "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,6 @@\n"
    " def total(items):\n     return sum(items)\n+\n+\n+def mean(items):\n+    return sum(items) / len(items)\n"
)
DEFECT_LINE = 6


def write_case(checkout: str, case_id: str, split: str = "train", lens: str = "boundary", locations=None, base: bool = True, change: str = CHANGE) -> str:
    directory = os.path.join(checkout, CASES, case_id)
    os.makedirs(directory)
    if base:
        os.makedirs(os.path.join(directory, "base"))
        with open(os.path.join(directory, "base", "calc.py"), "w", encoding="utf-8") as handle:
            handle.write(BASE_TEXT)
    with open(os.path.join(directory, "change.diff"), "w", encoding="utf-8") as handle:
        handle.write(change)
    if locations is None:
        locations = [] if lens == "control" else [{"file": "calc.py", "line": DEFECT_LINE}]
    with open(os.path.join(directory, "expect.json"), "w", encoding="utf-8") as handle:
        json.dump({"lens": lens, "must_find": "mean divides by zero on an empty list", "source": "test", "split": split, "locations": locations}, handle)
    return directory


def finding(quote: str, file: str = "{{REPO}}/calc.py", impact: str = "high") -> dict:
    return {"id": "f1", "summary": "s", "impact": impact, "file": file, "quote": quote, "repro": "static: contract at calc.py:6"}


def result(blocking=(), non_blocking=()) -> dict:
    return {"verdict": "NEEDS_FIXES" if blocking else "PASS", "blocking": list(blocking), "nonBlocking": list(non_blocking)}


class CasesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp()
        self.keel, self.overlay = os.path.join(self.root, "keel"), os.path.join(self.root, "overlay")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_load_mergesKeelAndOverlayCases(self) -> None:
        write_case(self.keel, "mean-1")
        write_case(self.overlay, "control-1", lens="control", split="holdout")
        cases = load_review_cases([self.keel, self.overlay])
        self.assertEqual([(case.id, case.split, case.is_clean, len(case.locations)) for case in cases],
                         [("mean-1", "train", False, 1), ("control-1", "holdout", True, 0)])

    def test_load_refusesTheSameIdInBothCheckouts(self) -> None:
        write_case(self.keel, "mean-1")
        write_case(self.overlay, "mean-1")
        with self.assertRaisesRegex(CaseError, "in both"):
            load_review_cases([self.keel, self.overlay])

    def test_load_refusesAControlCaseWithLocations(self) -> None:
        write_case(self.keel, "control-1", lens="control", locations=[{"file": "calc.py", "line": 1}])
        with self.assertRaisesRegex(CaseError, "no locations"):
            load_review_cases([self.keel])

    def test_load_refusesADefectCaseWithoutLocations(self) -> None:
        write_case(self.keel, "mean-1", locations=[])
        with self.assertRaisesRegex(CaseError, "at least one"):
            load_review_cases([self.keel])

    def test_load_refusesALocationOutsideTheRepo(self) -> None:
        write_case(self.keel, "mean-1", locations=[{"file": "../calc.py", "line": 1}])
        with self.assertRaisesRegex(CaseError, "relative"):
            load_review_cases([self.keel])


class BuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp()
        self.keel = os.path.join(self.root, "keel")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_build_commitsTheBaseThenTheChange(self) -> None:
        write_case(self.keel, "mean-1")
        case = load_review_cases([self.keel])[0]
        repo, base, head = build_case_repo(case, os.path.join(self.root, "work"))
        self.assertEqual(run_git(repo, ["show", base + ":calc.py"]), BASE_TEXT)
        self.assertIn("+def mean(items):", run_git(repo, ["diff", base, head]))
        self.assertEqual(run_git(repo, ["status", "--porcelain"]), "")

    def test_build_appliesTheChange_whenTheCheckoutPathIsRelative(self) -> None:
        write_case(self.keel, "mean-1")
        case = load_review_cases([os.path.relpath(self.keel)])[0]
        repo, base, head = build_case_repo(case, os.path.join(self.root, "work"))
        self.assertIn("+def mean(items):", run_git(repo, ["diff", base, head]))

    def test_build_refusesALocationPastTheEndOfTheFile(self) -> None:
        write_case(self.keel, "mean-1", locations=[{"file": "calc.py", "line": 7}])
        case = load_review_cases([self.keel])[0]
        with self.assertRaisesRegex(BuildError, "no such line"):
            build_case_repo(case, os.path.join(self.root, "work"))

    def test_build_refusesAChangeThatDoesNotApply(self) -> None:
        write_case(self.keel, "mean-1", base=False)
        case = load_review_cases([self.keel])[0]
        with self.assertRaises(BuildError):
            build_case_repo(case, os.path.join(self.root, "work"))


class GradeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp()
        keel = os.path.join(self.root, "keel")
        write_case(keel, "mean-1")
        write_case(keel, "control-1", lens="control")
        self.defect, self.clean = sorted(load_review_cases([keel]), key=lambda case: case.is_clean)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_blockingFindingAtTheLine_isAHit(self) -> None:
        grade = grade_result(self.defect, 1, result([finding("/tmp/x/app/calc.py:6 `return sum(items) / len(items)`")]))
        self.assertEqual((grade.hit, grade.passed, grade.blocking), (True, True, 1))

    def test_lineToleranceIsThreeLinesEitherSide(self) -> None:
        self.assertTrue(grade_result(self.defect, 1, result([finding("calc.py:9")])).hit)
        self.assertTrue(grade_result(self.defect, 1, result([finding("calc.py:3")])).hit)
        self.assertFalse(grade_result(self.defect, 1, result([finding("calc.py:10")])).hit)
        self.assertFalse(grade_result(self.defect, 1, result([finding("calc.py:2")])).hit)

    def test_aQuotedRangeOverlappingTheWindow_isAHit(self) -> None:
        self.assertFalse(grade_result(self.defect, 1, result([finding("calc.py:10-12")])).hit)
        self.assertTrue(grade_result(self.defect, 1, result([finding("calc.py:1-3")])).hit)

    def test_bareLineRef_countsOnlyWhenTheFindingsFileIsTheExpectedOne(self) -> None:
        self.assertTrue(grade_result(self.defect, 1, result([finding("line :6 divides")])).hit)
        self.assertFalse(grade_result(self.defect, 1, result([finding("line :6 divides", file="{{REPO}}/other.py")])).hit)

    def test_anotherFileAtTheSameLine_isAMiss(self) -> None:
        self.assertFalse(grade_result(self.defect, 1, result([finding("other.py:6", file="{{REPO}}/other.py")])).hit)

    def test_anotherFileWithTheSameSuffix_isAMiss(self) -> None:
        self.assertFalse(grade_result(self.defect, 1, result([finding("xcalc.py:6", file="{{REPO}}/xcalc.py")])).hit)

    def test_nonBlockingFindingAtTheLine_isAMiss(self) -> None:
        grade = grade_result(self.defect, 1, result(non_blocking=[finding("calc.py:6", impact="low")]))
        self.assertEqual((grade.hit, grade.passed, grade.blocking), (False, False, 0))

    def test_cleanCase_failsOnAnyBlockingFinding(self) -> None:
        self.assertTrue(grade_result(self.clean, 1, result(non_blocking=[finding("calc.py:6", impact="low")])).passed)
        noisy = grade_result(self.clean, 1, result([finding("calc.py:6"), finding("calc.py:1")]))
        self.assertEqual((noisy.passed, noisy.blocking, noisy.hit), (False, 2, False))

    def test_suiteNumbers_recallNoiseVarianceAgreement(self) -> None:
        grades = [
            grade_result(self.defect, 1, result([finding("calc.py:6")])),
            grade_result(self.defect, 2, result()),
            grade_result(self.clean, 1, result()),
            grade_result(self.clean, 2, result([finding("calc.py:1")])),
        ]
        numbers = suite_numbers(grades)
        self.assertEqual({key: numbers["train"][key] for key in ("defect_runs", "hits", "recall", "clean_runs", "noisy_runs", "noise_rate", "blocking_per_clean_run", "recall_stdev")},
                         {"defect_runs": 2, "hits": 1, "recall": 0.5, "clean_runs": 2, "noisy_runs": 1, "noise_rate": 0.5, "blocking_per_clean_run": 0.5, "recall_stdev": 0.5})
        self.assertEqual((numbers["case_agreement"], numbers["headroom"], numbers["holdout"]["recall"]), (0.0, True, None))

    def test_suiteNumbers_reportNoHeadroomWhenTrainIsPerfect(self) -> None:
        grades = [grade_result(self.defect, 1, result([finding("calc.py:6")])), grade_result(self.clean, 1, result())]
        self.assertFalse(suite_numbers(grades)["headroom"])


class ReviewEvalCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.scenarios = os.path.join(self.box.root, "scenarios")
        os.makedirs(self.scenarios)
        self.box.env.update(PATH=REVIEW_STUB_DIR + os.pathsep + self.box.env.get("PATH", ""), KEEL_TEST_SCENARIOS=self.scenarios,
                            CLAUDE_CONFIG_DIR=self.box.data)
        write_case(self.box.keel, "mean-1")
        write_case(self.box.keel, "mean-2", split="holdout")
        write_case(self.box.keel, "control-1", lens="control")

    def tearDown(self) -> None:
        self.box.cleanup()

    def play(self, rounds: list) -> None:
        with open(os.path.join(self.scenarios, "review.json"), "w", encoding="utf-8") as handle:
            json.dump({"rounds": rounds}, handle)

    def run_eval(self, *args: str) -> tuple[subprocess.CompletedProcess, dict | None]:
        completed = subprocess.run([REVIEW_EVAL] + list(args), capture_output=True, text=True, env=self.box.env, cwd=self.box.root)
        return completed, json.loads(completed.stdout) if completed.stdout.strip() else None

    def calls(self) -> list:
        with open(os.path.join(self.scenarios, "calls.jsonl"), encoding="utf-8") as handle:
            return [json.loads(line) for line in handle]

    def summary_lines(self) -> list:
        path = os.path.join(self.box.data, "logs", "keel-review-eval.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle]

    def test_fullRun_printsRecallNoiseAndVariance_andLogsOneSummaryLine(self) -> None:
        hit = {"result": result([finding("{{REPO}}/calc.py:6 `return sum(items) / len(items)`")])}
        self.play([{"result": result()}, {"result": result()}, hit, hit, hit, {"result": result()}])
        completed, report = self.run_eval("--repeat", "2")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        numbers = report["numbers"]
        self.assertEqual((numbers["train"]["recall"], numbers["train"]["noise_rate"], numbers["holdout"]["recall"], numbers["holdout"]["recall_stdev"]), (1.0, 0.0, 0.5, 0.5))
        self.assertEqual((numbers["case_agreement"], numbers["headroom"], report["faults"]), (round(2 / 3, 4), False, []))
        self.assertIn("review-eval train: recall 1.0 (2/2), noise 0.0 (0/2 clean runs)", completed.stderr)
        self.assertEqual([line["numbers"] for line in self.summary_lines()], [numbers])
        self.assertEqual(os.listdir(os.path.join(self.box.data, "projects")), [])

    def test_prompt_namesTheWorkflowTheBuiltRangeAndTheCallerSkill(self) -> None:
        expect_path = os.path.join(self.box.keel, CASES, "mean-1", "expect.json")
        with open(expect_path, encoding="utf-8") as handle:
            expect = json.load(handle)
        expect.update(caller_skill="demo-lenses", requirement="Add a mean helper.")
        with open(expect_path, "w", encoding="utf-8") as handle:
            json.dump(expect, handle)
        self.play([{"result": result()}])
        completed, _ = self.run_eval("--case", "mean-1", "--repeat", "1")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        call = self.calls()[0]
        workflow_args = json.loads(call["prompt"].splitlines()[1])
        self.assertEqual((workflow_args["diffs"][0]["repo"], workflow_args["requirement"]), (call["cwd"], "Add a mean helper."))
        self.assertIn("the skill demo-lenses", call["prompt"])
        self.assertIn("--disallowedTools", call["argv"])
        self.assertNotIn("disableAllHooks", " ".join(call["argv"]))
        self.assertEqual(self.summary_lines(), [])

    def test_runWithoutAWorkflowRecord_isAFault_notAMiss(self) -> None:
        self.play([{"record": False}])
        completed, report = self.run_eval("--case", "mean-1", "--repeat", "1")
        self.assertEqual(completed.returncode, 1)
        self.assertEqual((report["faults"][0]["case"], report["numbers"]["train"]["defect_runs"]), ("mean-1", 0))
        self.assertIn("no lens-review workflow record", report["faults"][0]["reason"])

    def test_erroredWorkflow_isAFault(self) -> None:
        self.play([{"result": {"verdict": "ERROR", "error": "prepare failed"}}])
        completed, report = self.run_eval("--case", "mean-1", "--repeat", "1")
        self.assertEqual(completed.returncode, 1)
        self.assertIn("prepare failed", report["faults"][0]["reason"])

    def test_faultedFullRun_writesNoSummaryLine(self) -> None:
        self.play([{"result": result()}, {"record": False}, {"result": result()}])
        completed, _ = self.run_eval("--repeat", "1")
        self.assertEqual((completed.returncode, self.summary_lines()), (1, []))

    def test_regrade_gradesTheSameRecordsTheSame_andCatchesAChangedGrade(self) -> None:
        self.play([{"result": result([finding("{{REPO}}/calc.py:6")])}])
        _, report = self.run_eval("--case", "mean-1", "--repeat", "1")
        raw_dir = report["raw_dir"]
        same, same_report = self.run_eval("--regrade", raw_dir)
        write_case_location(self.box.keel, "mean-1", 1)
        changed, changed_report = self.run_eval("--regrade", raw_dir)
        self.assertEqual((same.returncode, same_report["same_grade"], same_report["runs"]), (0, 1, 1))
        self.assertEqual((changed.returncode, changed_report["same_grade"]), (1, 0))
        self.assertEqual(len(self.calls()), 1)

    def test_gradesTheLatestLensReviewRecordOfTheSession_whateverTheFileOrder(self) -> None:
        latest = {"startTime": 9, "result": result([finding("{{REPO}}/calc.py:6")])}
        earlier = {"startTime": 1, "result": {"verdict": "ERROR", "error": "earlier attempt"}}
        newest_other = {"startTime": 20, "workflowName": "other-workflow", "result": result()}
        self.play([{"records": [latest, earlier, newest_other]}, {"records": [earlier, latest, newest_other]}])
        completed, report = self.run_eval("--case", "mean-1", "--repeat", "2")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((report["faults"], report["numbers"]["train"]["hits"]), ([], 2))

    def test_killedRecord_resultWithoutBlockingList_andTimeout_areFaults(self) -> None:
        cases = [
            ({"status": "killed", "result": result()}, (), "status 'killed'"),
            ({"result": {"verdict": "PASS"}}, (), "no blocking list"),
            ({"result": result(), "sleep": 5}, ("--timeout-seconds", "1"), "timed out after 1s"),
        ]
        for scenario, extra, reason in cases:
            with self.subTest(reason=reason):
                self.play([scenario])
                completed, report = self.run_eval("--case", "mean-1", "--repeat", "1", *extra)
                self.assertEqual(completed.returncode, 1)
                self.assertIn(reason, report["faults"][0]["reason"])
                self.assertEqual(report["numbers"]["train"]["defect_runs"], 0)

    def test_reportAndSummaryLine_carryTheReviewerFingerprint(self) -> None:
        workflow = os.path.join(self.box.data, "workflows", "lens-review.js")
        os.makedirs(os.path.dirname(workflow))
        with open(workflow, "w", encoding="utf-8") as handle:
            handle.write("export const meta = {}\n")
        self.play([{"result": result()}])
        completed, report = self.run_eval("--repeat", "1")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        expected = {"lens-review.js": hashlib.sha256(b"export const meta = {}\n").hexdigest(), "adversarial-audit.js": None}
        self.assertEqual((report["reviewer"], self.summary_lines()[0]["reviewer"]), (expected, expected))

    def test_dryRun_buildsEveryCaseAndCallsNothing(self) -> None:
        completed, plan = self.run_eval("--dry-run")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual([case["id"] for case in plan["cases"]], ["control-1", "mean-1", "mean-2"])
        self.assertFalse(os.path.exists(os.path.join(self.scenarios, "calls.jsonl")))

    def test_caseThatDoesNotBuild_stopsTheRunBeforeAnyReview(self) -> None:
        write_case(self.box.keel, "mean-3", base=False)
        completed, _ = self.run_eval("--repeat", "1")
        self.assertEqual(completed.returncode, 2)
        self.assertIn("mean-3", completed.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.scenarios, "calls.jsonl")))


class ShippedCasesTest(unittest.TestCase):
    def test_keelCasesBuildAndPointAtExistingLines(self) -> None:
        cases = load_review_cases([CHECKOUT])
        self.assertEqual(sorted((case.split, case.is_clean) for case in cases), [("holdout", False), ("train", False), ("train", True)])
        for case in cases:
            work = tempfile.mkdtemp()
            try:
                build_case_repo(case, os.path.join(work, case.id))
            finally:
                shutil.rmtree(work, ignore_errors=True)


def write_case_location(checkout: str, case_id: str, line: int) -> None:
    path = os.path.join(checkout, CASES, case_id, "expect.json")
    with open(path, encoding="utf-8") as handle:
        expect = json.load(handle)
    expect["locations"] = [{"file": "calc.py", "line": line}]
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(expect, handle)


if __name__ == "__main__":
    unittest.main()
