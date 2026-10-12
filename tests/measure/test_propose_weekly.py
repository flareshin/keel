from __future__ import annotations

import os
import unittest
from datetime import timedelta

from helpers import FUTURE, PAST, TODAY, MeasureSandbox, charter_row, ledger_row

EXTENDED = (TODAY + timedelta(days=60)).isoformat()


class ProposeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()

    def tearDown(self) -> None:
        self.box.cleanup()

    def propose(self, *args: str) -> list:
        completed, result = self.box.run_json("propose", *args)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return result["proposals"]

    def test_propose_demotesOneLayer_whenExpiredRowCountsZero(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [
            ledger_row("C-hook", review_by=PAST),
            ledger_row("C-skill", review_by=PAST, layer="skill", enforced_at="skill:demo", why_not_stronger="Judgment."),
            ledger_row("C-prose", review_by=PAST, layer="prose", enforced_at="prose:PRINCIPLES.md", why_not_stronger="Judgment."),
        ])
        # when
        proposals = self.propose()
        # then
        self.assertEqual([(p["id"], p["action"], p["from"], p["to"]) for p in proposals], [
            ("C-hook", "demote", "hook", "skill"),
            ("C-skill", "demote", "skill", "prose"),
            ("C-prose", "retire", "prose", "retired"),
        ])

    def test_propose_extendsReviewBySixtyDays_whenExpiredRowStillCounts(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [ledger_row("C-demo", review_by=PAST)])
        self.box.fire("C-demo")
        # when
        proposals = self.propose()
        # then
        self.assertEqual(proposals, [{"id": "C-demo", "action": "extend", "from": PAST, "to": EXTENDED, "reason": "metric counted 1 item(s) in the window"}])

    def test_propose_rechecksRepoRow_whenExistenceCheckFails(self) -> None:
        # given
        missing = os.path.join(self.box.root, "nowhere")
        self.box.write_ledger("keel/ledger.tsv", [ledger_row("C-repo", layer="repo", enforced_at="repo:acme/app:lint.cfg", metric="exists:%s:HEAD:lint.cfg" % missing, review_by=PAST)])
        # when
        proposals = self.propose()
        # then
        self.assertEqual([(p["action"], p["from"], p["to"]) for p in proposals], [("recheck", "repo", "repo")])

    def test_propose_rechecksInsteadOfDemoting_whenTheMetricRunnerFails(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [ledger_row("C-demo", review_by=PAST, metric="run:crashes")])
        self.box.write("keel/measure/metrics/crashes", "#!/bin/bash\necho boom >&2\nexit 3\n", executable=True)
        # when
        proposals = self.propose()
        # then
        self.assertEqual([(p["id"], p["action"], p["from"], p["to"]) for p in proposals], [("C-demo", "recheck", "hook", "hook")])
        self.assertEqual(proposals[0]["reason"], "metric errored, nothing counted: runner crashes exited 3: boom")

    def test_propose_ignoresRowsNotYetExpiredAndCharterRows(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1"), ledger_row("C-fresh", review_by=FUTURE), ledger_row("C-done", review_by=PAST, status="retired")])
        # when
        proposals = self.propose()
        # then
        self.assertEqual(proposals, [])

    def test_propose_emitsOneRereviewPerActiveRow_onModelUpgrade(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1"), ledger_row("C-demo"), ledger_row("C-done", status="retired")])
        # when
        proposals = self.propose("--model-upgrade", "model-next")
        # then
        self.assertEqual([(p["id"], p["action"]) for p in proposals], [("K1", "rereview"), ("C-demo", "rereview")])
        self.assertIn("model-next", proposals[0]["reason"])


class WeeklyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.box.init_repo(self.box.keel)

    def tearDown(self) -> None:
        self.box.cleanup()

    def test_weekly_listsRepoRulesProposalsAndAlwaysLoadedBytes(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [
            charter_row("K1"),
            ledger_row("C-late", review_by=PAST, grace_until=FUTURE),
            ledger_row("C-repo", layer="repo", enforced_at="repo:acme/app:lint.cfg", metric="exists:/nowhere:HEAD:lint.cfg"),
        ])
        self.box.write("data/CLAUDE.md", "x" * 100)
        self.box.write("data/projects/a/memory/MEMORY.md", "y" * 30)
        self.box.write("data/projects/b/memory/MEMORY.md", "z" * 20)
        # when
        completed, report = self.box.run_json("weekly")
        # then
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(set(report), {"repo_layer_rules", "always_loaded", "core_size", "defects", "proposals"})
        self.assertEqual(report["repo_layer_rules"], {"count": 1, "ids": ["C-repo"]})
        self.assertEqual(report["always_loaded"], {"claude_md": 100, "memory_indexes": 50})
        self.assertEqual([(p["id"], p["action"]) for p in report["proposals"]], [("C-late", "demote")])
        self.assertEqual(report["defects"], {})

    def test_weekly_reportsCoreNonTestLocAndDesignBytes_fromTrackedFiles(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1")])
        self.box.write("keel/lib/tool.py", "a = 1\nb = 2\n")
        self.box.write("keel/bin/tool", "#!/bin/sh\necho\necho\n", executable=True)
        self.box.write("keel/tests/test_tool.py", "x = 1\n" * 50)
        self.box.write("keel/skills/demo/SKILL.md", "line\n" * 9)
        self.box.write("keel/docs/DESIGN.md", "d" * 120)
        self.box.commit_all(self.box.keel)
        self.box.write("keel/lib/untracked.py", "c = 3\n")
        # when
        _, report = self.box.run_json("weekly")
        # then
        self.assertEqual(report["core_size"], {"non_test_loc": 5, "design_md_bytes": 120})

    def test_weekly_reportsOverlayDefectRunners_andTheirErrors(self) -> None:
        # given
        self.box.write_ledger("keel/ledger.tsv", [charter_row("K1")])
        self.box.write("overlay/measure/metrics/defects-reverts", '#!/bin/bash\necho \'{"count": 1, "items": ["abc"]}\'\n', executable=True)
        self.box.write("overlay/measure/metrics/defects-broken", "#!/bin/bash\nexit 3\n", executable=True)
        self.box.write("overlay/measure/metrics/other", "#!/bin/bash\necho ignored\n", executable=True)
        # when
        _, report = self.box.run_json("weekly")
        # then
        self.assertEqual(report["defects"]["defects-reverts"], {"count": 1, "items": ["abc"]})
        self.assertIn("exited 3", report["defects"]["defects-broken"]["error"])
        self.assertNotIn("other", report["defects"])


if __name__ == "__main__":
    unittest.main()
