from __future__ import annotations

import os
import shutil
import unittest
from datetime import date

from helpers import CHECKOUT, LEDGER_COLUMNS, TODAY, MeasureSandbox, read_text

SEED_IDS = [
    "K1", "K2", "K3", "K4", "K5", "risk", "F-irreversible", "F-secrets", "F-attribution",
    "F-force-push", "F-hookskip", "F-mod-trust", "C-dispatch", "C-handoff", "C-isolation", "S-jdk",
]
SEED_GRACE_UNTIL = date(2026, 12, 10)
STATUS_WITHOUT_EVIDENCE = "GRACE" if TODAY <= SEED_GRACE_UNTIL else "FAIL"


class SeedLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        shutil.copy(os.path.join(CHECKOUT, "ledger.tsv"), os.path.join(self.box.keel, "ledger.tsv"))

    def tearDown(self) -> None:
        self.box.cleanup()

    def test_seedLedger_hasTheExactHeaderAndSeedIds(self) -> None:
        # given
        lines = read_text(os.path.join(CHECKOUT, "ledger.tsv")).splitlines()
        # then
        self.assertEqual(lines[0], "\t".join(LEDGER_COLUMNS))
        self.assertEqual([line.split("\t")[0] for line in lines[1:]], SEED_IDS)
        self.assertTrue(all(len(line.split("\t")) == len(LEDGER_COLUMNS) for line in lines))

    def test_seedLedger_passesFormatUniquenessAndCaps(self) -> None:
        # when
        _, result = self.box.run_json("smoke", "--json-only")
        # then
        relevant = [item for item in result["assertions"] if item["check"] in ("ledger-format", "id-unique", "caps")]
        self.assertEqual([item for item in relevant if item["status"] != "PASS"], [])
        self.assertIn({"check": "caps", "scope": "core", "status": "PASS", "detail": "4/10"}, relevant)

    def test_seedLedger_isGraceUntilItsGraceDate_forRuleOfTwoAndMetricsWithNoFiresYet(self) -> None:
        # when
        _, result = self.box.run_json("smoke", "--json-only")
        # then
        statuses = {(item["check"], item["scope"]): item["status"] for item in result["assertions"]}
        self.assertEqual(statuses[("rule-of-two", "keel")], STATUS_WITHOUT_EVIDENCE)
        self.assertEqual(statuses[("metrics", "keel")], STATUS_WITHOUT_EVIDENCE)

    def test_seedLedger_runsEveryRowMetric_withGraceStatusBeforeAnyFires(self) -> None:
        expected_exit = 0 if STATUS_WITHOUT_EVIDENCE == "GRACE" else 1
        for row_id in SEED_IDS:
            # when
            completed, result = self.box.run_json("run", row_id)
            # then
            self.assertEqual((completed.returncode, result["status"]), (expected_exit, STATUS_WITHOUT_EVIDENCE), row_id)

    def test_seedLedger_modTrustMetricCountsTheShippedCheck_whenTheLiveCheckoutHoldsIt(self) -> None:
        # given: a live keel checkout at the metric's path holding the file the metric names
        metric = self.seed_row("F-mod-trust")["metric"]
        repo, ref, path = metric[len("exists:"):].split(":", 2)
        live = os.path.join(self.box.env["HOME"], repo[len("~/"):])
        self.box.write(os.path.relpath(os.path.join(live, path), self.box.root), "shipped check\n")
        self.box.git(live, "init", "-q")
        self.box.commit_all(live)
        # when
        completed, result = self.box.run_json("run", "F-mod-trust")
        # then
        self.assertTrue(os.path.isfile(os.path.join(CHECKOUT, path)), path)
        self.assertEqual((repo[:len("~/")], ref), ("~/", "HEAD"))
        self.assertEqual((completed.returncode, result["status"], result["count"]), (0, "PASS", 1))

    def seed_row(self, row_id: str) -> dict:
        lines = read_text(os.path.join(CHECKOUT, "ledger.tsv")).splitlines()
        rows = [dict(zip(LEDGER_COLUMNS, line.split("\t"))) for line in lines[1:]]
        return next(row for row in rows if row["id"] == row_id)


if __name__ == "__main__":
    unittest.main()
