from __future__ import annotations

import os
import unittest
from datetime import timedelta

from helpers import FUTURE, NOW_TS, PAST, TODAY, MeasureSandbox, ledger_row


class MeasureRunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()

    def tearDown(self) -> None:
        self.box.cleanup()

    def given_keel_rows(self, *rows) -> None:
        self.box.write_ledger("keel/ledger.tsv", list(rows))

    def test_run_countsFiresInWindow_excludingErrorsAndOtherIds(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo"))
        self.box.fire("C-demo")
        self.box.fire("C-demo", outcome="pass")
        self.box.fire("C-demo", outcome="error")
        self.box.fire("C-other")
        old_ts = (TODAY - timedelta(days=90)).isoformat() + "T00:00:00Z"
        self.box.fire("C-demo", ts=old_ts)
        # when
        completed, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((result["id"], result["metric"], result["count"], result["status"]), ("C-demo", "fires:C-demo", 2, "PASS"))

    def test_run_skipsContractMissLines_becauseTheyRecordAPayloadChangeNotADecision(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo"))
        self.box.fire("C-demo")
        self.box.fire("C-demo", outcome="contract-miss")
        # when
        _, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual(result["count"], 1, result)

    def test_run_includesOlderFires_whenSinceIsGiven(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo"))
        self.box.fire("C-demo", ts="2020-01-02T00:00:00Z")
        # when
        _, result = self.box.run_json("run", "C-demo", "--since", "2020-01-01")
        # then
        self.assertEqual(result["count"], 1)

    def test_run_reportsGrace_whenZeroItemsBeforeGraceUntil(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo", grace_until=FUTURE))
        # when
        completed, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((completed.returncode, result["count"], result["status"]), (0, 0, "GRACE"))

    def test_run_failsWithExitOne_whenZeroItemsAfterGraceUntil(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo", grace_until=PAST))
        # when
        completed, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((completed.returncode, result["status"]), (1, "FAIL"))

    def test_run_countsOnlyPassingEvals_forEvalsMetric(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo", metric="evals:demo"))
        self.box.append_log("keel-evals.jsonl", {"ts": NOW_TS, "eval_id": "demo", "rule_id": "C-demo", "case": "a", "pass": True, "model": "m"})
        self.box.append_log("keel-evals.jsonl", {"ts": NOW_TS, "eval_id": "demo", "rule_id": "C-demo", "case": "b", "pass": False, "model": "m"})
        # when
        _, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((result["count"], result["status"]), (1, "PASS"))

    def test_run_usesOverlayRunner_whenKeelHasNone(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo", metric="run:demo-runner"))
        self.box.write("overlay/measure/metrics/demo-runner", '#!/bin/bash\necho \'{"count": 2, "items": ["a", "b"]}\'\n', executable=True)
        # when
        _, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((result["count"], result["items"], result["status"]), (2, ["a", "b"], "PASS"))

    def test_run_failsWithError_whenRunnerPrintsNoJson(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo", metric="run:broken", grace_until=FUTURE))
        self.box.write("keel/measure/metrics/broken", "#!/bin/bash\necho not-json\n", executable=True)
        # when
        completed, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((completed.returncode, result["status"]), (1, "FAIL"))
        self.assertIn("did not print one JSON object", result["error"])

    def test_run_failsWithError_whenRunnerIsMissing(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo", metric="run:absent"))
        # when
        completed, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertIn("no runner", result["error"])

    def test_run_countsOneItem_whenExistsMetricFindsThePath(self) -> None:
        # given
        repo = os.path.join(self.box.root, "target")
        self.box.write("target/lint/rule.cfg", "rule\n")
        self.box.init_repo(repo, "https://example.invalid/acme/target.git")
        self.box.commit_all(repo)
        self.given_keel_rows(ledger_row("C-demo", layer="repo", enforced_at="repo:acme/target:lint/rule.cfg", metric="exists:%s:HEAD:lint/rule.cfg" % repo))
        # when
        _, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((result["count"], result["items"], result["status"]), (1, ["HEAD:lint/rule.cfg"], "PASS"))

    def test_run_failsExistsMetric_whenThePathIsMissing(self) -> None:
        # given
        repo = os.path.join(self.box.root, "target")
        self.box.write("target/README", "x\n")
        self.box.init_repo(repo)
        self.box.commit_all(repo)
        self.given_keel_rows(ledger_row("C-demo", metric="exists:%s:HEAD:lint/rule.cfg" % repo))
        # when
        completed, result = self.box.run_json("run", "C-demo")
        # then
        self.assertEqual((completed.returncode, result["count"], result["status"]), (1, 0, "FAIL"))

    def test_run_findsOverlayRows_fromTheOverlayLedger(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo"))
        self.box.write_ledger("overlay/ledger.tsv", [ledger_row("O-demo", scope="overlay", incidents="private:a,private:b")])
        self.box.fire("O-demo")
        # when
        _, result = self.box.run_json("run", "O-demo")
        # then
        self.assertEqual((result["id"], result["status"]), ("O-demo", "PASS"))

    def test_run_expandsTilde_whenDataAndOverlayDirsStartWithTilde(self) -> None:
        # given
        home = self.box.env["HOME"]
        self.given_keel_rows(ledger_row("C-demo"))
        self.box.write_ledger("home/ov/ledger.tsv", [ledger_row("O-demo", scope="overlay", incidents="private:a,private:b")])
        fires = os.path.join(home, "kd", "logs", "keel-fires.jsonl")
        os.makedirs(os.path.dirname(fires))
        with open(fires, "w", encoding="utf-8") as handle:
            handle.write('{"ts": "%s", "rule_id": "O-demo", "hook": "ship-gate", "outcome": "deny", "session": "-"}\n' % NOW_TS)
        self.box.env.update(KEEL_DATA_DIR="~/kd", KEEL_OVERLAY_DIR="~/ov")
        # when
        completed, result = self.box.run_json("run", "O-demo")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((result["count"], result["status"]), (1, "PASS"))

    def test_run_exitsTwo_whenIdIsUnknown(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo"))
        # when
        completed = self.box.run_measure("run", "C-nope")
        # then
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")

    def test_run_exitsTwo_whenSinceIsNotADate(self) -> None:
        # given
        self.given_keel_rows(ledger_row("C-demo"))
        # when
        completed = self.box.run_measure("run", "C-demo", "--since", "yesterday")
        # then
        self.assertEqual(completed.returncode, 2)


if __name__ == "__main__":
    unittest.main()
