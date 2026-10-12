from __future__ import annotations

import json
import os
import unittest

from helpers import CHECKOUT, FUTURE, PAST, MeasureSandbox, charter_row, ledger_row, read_text

class SmokeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.box = MeasureSandbox()
        self.box.seed_clean_keel()

    def tearDown(self) -> None:
        self.box.cleanup()

    def run_smoke(self):
        completed, result = self.box.run_json("smoke", "--json-only")
        self.assertIsNotNone(result, completed.stderr)
        return completed, result

    def assertion(self, check: str, scope: str) -> dict:
        _, result = self.run_smoke()
        matches = [item for item in result["assertions"] if item["check"] == check and item["scope"] == scope]
        self.assertEqual(len(matches), 1, result["assertions"])
        return matches[0]

    def assertStatus(self, check: str, scope: str, status: str, detail_part: str = "") -> dict:
        item = self.assertion(check, scope)
        self.assertEqual(item["status"], status, item)
        self.assertIn(detail_part, item["detail"])
        return item

    def keel_rows(self, *rows) -> None:
        self.box.write_ledger("keel/ledger.tsv", list(rows))


class SmokeRunTest(SmokeTestCase):
    def test_smoke_passesEveryAssertion_onACleanCheckout(self) -> None:
        # given: the clean sandbox
        # when
        completed, result = self.run_smoke()
        # then
        self.assertEqual(completed.returncode, 0)
        self.assertTrue(result["ok"])
        self.assertEqual([item for item in result["assertions"] if item["status"] != "PASS"], [])
        self.assertEqual(result["count"], len(result["assertions"]))
        self.assertEqual(result["cap"], 2 * 2 + 40)

    def test_smoke_appendsRunLineWithWorkingTree_toSmokeLog(self) -> None:
        # given
        self.box.write("keel/uncommitted.txt", "work in progress\n")
        # when
        _, result = self.run_smoke()
        # then
        line = self.box.last_log_line("keel-smoke.jsonl")
        self.assertEqual((line["run_id"], line["ok"], line["count"], line["failed"]), (result["run_id"], True, result["count"], []))
        self.assertRegex(line["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(list(line["trees"]), ["example/keel"])
        self.assertNotEqual(line["trees"]["example/keel"], self.box.git(self.box.keel, "rev-parse", "HEAD^{tree}").strip())
        self.assertEqual(self.box.git(self.box.keel, "status", "--porcelain"), "?? uncommitted.txt\n")

    def test_smoke_recordsNoTree_whenOriginHasNoOwnerSegment(self) -> None:
        # given
        self.box.git(self.box.keel, "remote", "set-url", "origin", "app.git")
        # when
        completed = self.box.run_measure("smoke", "--json-only")
        # then
        self.assertEqual(self.box.last_log_line("keel-smoke.jsonl")["trees"], {})
        self.assertIn("has no owner/repo origin", completed.stderr)

    def test_smoke_exitsOneAndPrintsSummary_whenAnAssertionFails(self) -> None:
        # given
        self.box.fire("C-unknown")
        # when
        completed = self.box.run_measure("smoke")
        # then
        self.assertEqual(completed.returncode, 1)
        self.assertIn("FAIL  fires-rule-ids/all", completed.stderr)
        line = self.box.last_log_line("keel-smoke.jsonl")
        self.assertEqual([(item["check"], item["scope"]) for item in line["failed"]], [("fires-rule-ids", "all")])


class LedgerCheckTest(SmokeTestCase):
    def test_ledgerFormat_fails_whenSkillRowLacksWhyNotStronger(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", layer="skill", enforced_at="skill:demo"))
        # then
        self.assertStatus("ledger-format", "keel", "FAIL", "C-demo (line 3): layer skill needs why_not_stronger")

    def test_ledgerFormat_fails_whenHeaderDiffers(self) -> None:
        # given
        self.box.write("keel/ledger.tsv", "id\tscope\n")
        # then
        self.assertStatus("ledger-format", "keel", "FAIL", "header must be exactly")

    def test_ledgerFormat_fails_whenKeelLedgerIsMissing(self) -> None:
        # given
        os.remove(os.path.join(self.box.keel, "ledger.tsv"))
        # then
        self.assertStatus("ledger-format", "keel", "FAIL", "no ledger")

    def test_ledgerFormat_passes_whenOverlayLedgerIsAbsent(self) -> None:
        self.assertStatus("ledger-format", "overlay", "PASS", "no ledger")

    def test_ledgerFormat_fails_whenOverlayLedgerHoldsACoreRow(self) -> None:
        # given
        self.box.write_ledger("overlay/ledger.tsv", [ledger_row("C-sneaky")])
        # then
        self.assertStatus("ledger-format", "overlay", "FAIL", "overlay rows live only in the overlay ledger")

    def test_ledgerFormat_passes_forTheShippedOverlayExample(self) -> None:
        # given
        example = os.path.join(CHECKOUT, "examples", "ledger-smoke", "ledger.tsv")
        self.box.write("overlay/ledger.tsv", read_text(example))
        # then
        self.assertStatus("ledger-format", "overlay", "PASS", "1 rows")

    def test_idUnique_fails_whenAnIdRepeatsAcrossLedgers(self) -> None:
        # given
        self.box.write_ledger("overlay/ledger.tsv", [ledger_row("O-x", scope="overlay"), ledger_row("O-x", scope="overlay")])
        # then
        self.assertStatus("id-unique", "all", "FAIL", "O-x")

    def test_coreCap_fails_whenElevenCoreRowsAreActive(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), *[ledger_row("C-r%d" % number) for number in range(11)])
        # then
        self.assertStatus("caps", "core", "FAIL", "11/10")

    def test_coreCap_excludesFloorAndRetiredRows(self) -> None:
        # given
        rows = [ledger_row("C-r%d" % number) for number in range(10)]
        rows.append(ledger_row("C-old", status="retired"))
        rows.append(ledger_row("F-demo", type="floor", justification="Why.", review_by="-"))
        self.keel_rows(charter_row("K1"), *rows)
        # then
        self.assertStatus("caps", "core", "PASS", "10/10")

    def test_stacksCap_fails_whenSixStacksHaveRows(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), *[ledger_row("S-r%d" % number, scope="stack:s%d" % number) for number in range(6)])
        # then
        self.assertStatus("caps", "stacks", "FAIL", "6/5")
        self.assertStatus("caps", "stack:s0", "PASS", "1/10")

    def test_ruleOfTwo_fails_whenOneIncidentAndGraceIsOver(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", incidents="docs/incidents/one.md", grace_until=PAST))
        # then
        self.assertStatus("rule-of-two", "keel", "FAIL", "C-demo: 1 of 2 incident refs")

    def test_ruleOfTwo_isGrace_whenOneIncidentBeforeGraceUntil(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", incidents="-", grace_until=FUTURE))
        # then
        self.assertStatus("rule-of-two", "keel", "GRACE", "in grace: C-demo")

    def test_ruleOfTwo_fails_whenAnIncidentFileIsMissing(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", incidents="docs/incidents/one.md,docs/incidents/gone.md"))
        # then
        self.assertStatus("rule-of-two", "keel", "FAIL", "missing incident files: docs/incidents/gone.md")

    def test_ruleOfTwo_fails_whenKeelLedgerCitesPrivateRefs(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", incidents="private:a,private:b"))
        # then
        self.assertStatus("rule-of-two", "keel", "FAIL", "private refs belong only in the overlay ledger")

    def test_ruleOfTwo_passes_whenOverlayRowCitesTwoPrivateRefs(self) -> None:
        # given
        self.box.write_ledger("overlay/ledger.tsv", [ledger_row("O-demo", scope="overlay", incidents="private:a,private:b")])
        self.box.fire("O-demo")
        # then
        self.assertStatus("rule-of-two", "overlay", "PASS", "1 rows checked")

    def test_ruleOfTwo_reportsFeedbackMemories_asIncidentCandidates_whenARowLacksIncidents(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", incidents="-", grace_until=FUTURE))
        self.box.write("data/projects/p1/memory/feedback_slow_tests.md", "note\n")
        # then
        self.assertStatus("rule-of-two", "keel", "GRACE", "incident candidates (feedback memories): feedback_slow_tests.md")

    def test_ruleOfTwo_omitsFeedbackMemories_whenEveryRowHasItsIncidents(self) -> None:
        # given
        self.box.write("data/projects/p1/memory/feedback_slow_tests.md", "note\n")
        # when
        item = self.assertStatus("rule-of-two", "keel", "PASS")
        # then
        self.assertNotIn("incident candidates", item["detail"])

    def test_metrics_fail_whenRowCountsZeroAfterGrace(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-silent", grace_until=PAST))
        # then
        self.assertStatus("metrics", "keel", "FAIL", "C-silent: 0 items for fires:C-silent")

    def test_metrics_fail_whenRowHasNoMetric(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo", metric="-", grace_until=FUTURE))
        # then
        self.assertStatus("metrics", "keel", "FAIL", "C-demo: row has no metric")

    def test_metrics_isGrace_whenRowCountsZeroBeforeGraceUntil(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-silent", grace_until=FUTURE))
        # then
        self.assertStatus("metrics", "keel", "GRACE", "C-silent")

    def test_expiry_warnsListingExpiredIds_whenARowIsPastReviewBy(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo"), ledger_row("C-silent", review_by=PAST, grace_until=FUTURE))
        # when
        item = self.assertStatus("expiry", "all", "WARN", "past review_by: C-silent (run measure/propose")
        # then
        self.assertNotIn("C-demo", item["detail"])

    def test_expiry_passes_whenNoRowIsPastReviewBy(self) -> None:
        # given
        self.keel_rows(charter_row("K1"), ledger_row("C-demo"))
        # then
        self.assertStatus("expiry", "all", "PASS", "no row past review_by")


class FileCheckTest(SmokeTestCase):
    def write_settings(self, scripts) -> None:
        groups = [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 /k/hooks/%s.py --flag" % name}]} for name in scripts]
        self.box.write("data/settings.json", json.dumps({"model": "x", "hooks": {"PreToolUse": groups}}))

    def test_hookScriptCap_fails_whenNineDistinctScriptsAreRegistered(self) -> None:
        # given
        self.write_settings(["h%d" % number for number in range(9)])
        # then
        self.assertStatus("caps", "hook-scripts", "FAIL", "9/8")

    def test_hookScriptCap_countsAScriptOnce_whenRegisteredForSeveralEvents(self) -> None:
        # given
        self.write_settings(["same"] * 9)
        # then
        self.assertStatus("caps", "hook-scripts", "PASS", "1/8: /k/hooks/same.py")

    def test_memoryIndexCap_warns_whenAnIndexExceeds8192Bytes(self) -> None:
        # given
        self.box.write("data/projects/p1/memory/MEMORY.md", "x" * 8193)
        # then
        self.assertStatus("caps", "memory-index", "WARN", "8193 bytes")

    def test_memoryIndexCap_passes_whenAnIndexIsExactly8192Bytes(self) -> None:
        # given
        self.box.write("data/projects/p1/memory/MEMORY.md", "x" * 8192)
        # then
        self.assertStatus("caps", "memory-index", "PASS", "1 indexes within 8192 bytes")

    def test_idTagging_fails_whenAPrinciplesBulletHasNoId(self) -> None:
        # given
        self.box.write("keel/PRINCIPLES.md", "- [K1] Tagged.\n- Untagged rule.\n")
        # then
        self.assertStatus("id-tagging", "principles", "FAIL", "line 2: bullet without [ID]")

    def test_idTagging_fails_whenATagNamesNoLedgerRow(self) -> None:
        # given
        self.box.write("keel/PRINCIPLES.md", "1. [C-ghost] Unknown.\n")
        # then
        self.assertStatus("id-tagging", "principles", "FAIL", "line 1: unknown id [C-ghost]")

    def test_idTagging_acceptsK5SubchecksAndSkipsFencedCode(self) -> None:
        # given
        self.box.write("keel/PRINCIPLES.md", "- [K5.16] Tests read as a spec.\n```\n- not a rule\n```\n")
        # then
        self.assertStatus("id-tagging", "principles", "PASS")

    def test_idTagging_warns_whenPrinciplesIsAbsent(self) -> None:
        # given
        os.remove(os.path.join(self.box.keel, "PRINCIPLES.md"))
        # then
        self.assertStatus("id-tagging", "principles", "WARN", "absent")

    def test_idTagging_checksOnlyTheRulesSectionOfASkill(self) -> None:
        # given
        self.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n- free bullet\n\n## Rules\n\n- [K1] Tagged.\n- Untagged.\n\n## Usage\n\n- free again\n")
        # then
        self.assertStatus("id-tagging", "skill:demo", "FAIL", "line 8: bullet without [ID]")

    def test_idTagging_checksTheRulesSection_whenTheHeadingCarriesAQualifier(self) -> None:
        # given
        self.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rules (hard)\n\n- [K1] Tagged.\n- Untagged.\n")
        # then
        self.assertStatus("id-tagging", "skill:demo", "FAIL", "line 6: bullet without [ID]")

    def test_idTagging_checksTheRulesSection_whenTheHeadingEndsWithAColon(self) -> None:
        # given
        self.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rules:\n\n- Untagged.\n")
        # then
        self.assertStatus("id-tagging", "skill:demo", "FAIL", "line 5: bullet without [ID]")

    def test_idTagging_checksTheRulesSection_whenTheHeadingIsLowercase(self) -> None:
        # given
        self.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## rules\n\n- Untagged.\n")
        # then
        self.assertStatus("id-tagging", "skill:demo", "FAIL", "line 5: bullet without [ID]")

    def test_idTagging_failsTheSkillsTotal_whenNoSkillHasARuleBullet(self) -> None:
        # given
        self.box.write("keel/skills/demo/SKILL.md", "# Demo\n\n## Rule list\n\n- Untagged.\n")
        # then
        self.assertStatus("id-tagging", "skill:demo", "PASS")
        self.assertStatus("id-tagging", "skills", "FAIL", "0 rule bullets")

    def test_idTagging_passesTheSkillsTotal_whenOneSkillHasATaggedRule(self) -> None:
        # given
        self.box.write("keel/skills/other/SKILL.md", "# Other\n\nNo rules here.\n")
        # then
        self.assertStatus("id-tagging", "skills", "PASS", "1 rule bullets across 2 skills")

    def test_idTagging_checksPersonalFromTheOverlay(self) -> None:
        # given
        self.box.write("overlay/PERSONAL.md", "* plain preference\n")
        # then
        self.assertStatus("id-tagging", "personal", "FAIL", "line 1")

    def test_firesRuleIds_fails_whenALogLineNamesAnUnknownId(self) -> None:
        # given
        self.box.fire("-")
        # then
        self.assertStatus("fires-rule-ids", "all", "FAIL", "unknown rule_ids: -")

    def test_firesRuleIds_acceptsOverlayRepoRuleIds(self) -> None:
        # given
        self.box.write("overlay/git-guard/repo-rules.tsv", "origin_glob\taction\tpattern\trule_id\tmessage\nacmecorp/*\tdeny-path\t*.sql\tO-files\tNo SQL.\n")
        self.box.fire("O-files")
        # then
        self.assertStatus("fires-rule-ids", "all", "PASS")

    def test_boundary_fails_whenATrackedFileHitsTheLexicon(self) -> None:
        # given
        self.box.write("keel/docs/leak.md", "Built for AcmeCorp.\n")
        self.box.commit_all(self.box.keel)
        # then
        self.assertStatus("boundary", "keel", "FAIL", "docs/leak.md:1 lexicon:1")

    def test_boundary_ignoresUntrackedFiles(self) -> None:
        # given
        self.box.write("keel/scratch.md", "acmecorp\n")
        # then
        self.assertStatus("boundary", "keel", "PASS")

    def test_boundary_fails_whenOverlayLexiconIsAbsent(self) -> None:
        # given
        os.remove(os.path.join(self.box.overlay, "boundary", "lexicon.txt"))
        # then
        self.assertStatus("boundary", "keel", "FAIL", "overlay lexicon absent")

    def test_boundary_fails_whenOverlayLexiconHasNoTerms(self) -> None:
        # given
        self.box.write("overlay/boundary/lexicon.txt", "# none yet\n")
        # then
        self.assertStatus("boundary", "keel", "FAIL", "has no terms")

    def test_linkIntegrity_fails_whenLinkCheckReportsProblems(self) -> None:
        # given
        self.box.write("stubs/link", '#!/bin/bash\necho \'{"actions":[],"problems":[{"kind":"dangling","path":"skills/x","detail":"-"}]}\'\nexit 1\n', executable=True)
        # then
        self.assertStatus("link-integrity", "all", "FAIL", "dangling skills/x")

    def test_linkIntegrity_fails_whenLinkToolIsMissing(self) -> None:
        # given
        os.remove(self.box.link_stub)
        # then
        self.assertStatus("link-integrity", "all", "FAIL", "link tool not executable")

    def test_dangling_fails_whenALinkedSkillPointsNowhere(self) -> None:
        # given
        os.makedirs(os.path.join(self.box.data, "skills", "real"))
        os.symlink(os.path.join(self.box.root, "gone"), os.path.join(self.box.data, "skills", "real", "SKILL.md"))
        os.symlink(self.box.keel, os.path.join(self.box.data, "skills", "alive"))
        # then
        self.assertStatus("dangling", "data", "FAIL", "1 dangling links: skills/real/SKILL.md")

    def test_assertionCap_fails_whenSkillsOutgrowTheAllowance(self) -> None:
        # given
        for number in range(30):
            self.box.write("keel/skills/s%d/SKILL.md" % number, "## Rules\n\n- [K1] Tagged.\n")
        # when
        completed, result = self.run_smoke()
        # then
        cap_item = [item for item in result["assertions"] if item["check"] == "assertion-cap"][0]
        self.assertEqual((cap_item["status"], result["cap"], completed.returncode), ("FAIL", 44, 1))
        self.assertGreater(result["count"], 44)


if __name__ == "__main__":
    unittest.main()
