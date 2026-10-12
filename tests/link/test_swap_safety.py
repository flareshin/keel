import glob
import json
import os
import unittest

from helpers import CORE_LINKS, LinkTestCase
from link.cli import read_accepted_drops
from link.config import Refused
from link.settings_json import list_dropped_items

LIVE_V1 = {
    "model": "opus",
    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "v1-stop.sh"}]}]},
    "permissions": {
        "allow": ["Read"],
        "deny": ["Bash(git push --force:*)", "Bash(v1-only-deny:*)"],
        "ask": ["Bash(v1-only-ask:*)"],
        "defaultMode": "auto",
    },
    "env": {"V1_TOKEN": "v1-secret-value"},
}
CORE_LINKS_WITH_DANGLING = CORE_LINKS + "{{KEEL}}/skills/missing\tskills/missing\n"
EXPECTED_DROPS = [
    "env V1_TOKEN (removed)",
    "hooks.Stop v1-stop.sh",
    "permissions.allow Read",
    "permissions.ask Bash(v1-only-ask:*)",
    "permissions.defaultMode auto",
    "permissions.deny Bash(v1-only-deny:*)",
]


class SwapTestCase(LinkTestCase):
    def setUp(self):
        super().setUp()
        self.v1_text = json.dumps(LIVE_V1, indent=2) + "\n"
        self.box.write_data("settings.json", self.v1_text)

    def accept_file(self, lines):
        path = os.path.join(self.box.root, "accepted-drops.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("# reviewed drops\n" + "".join(line + "\n" for line in lines))
        return path

    def adopt(self):
        return self.box.run_link("--write", "--adopt", "--accept-drops", self.accept_file(EXPECTED_DROPS))

    def backups(self):
        return sorted(glob.glob(os.path.join(self.box.data, "state", "keel", "link-backup", "*", "settings.json")))


class LinkAdoptTest(SwapTestCase):
    def test_write_exitsThreeAndKeepsSettings_whenNoLinkStateAndLiveOwnedKeysDiffer(self):
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("settings-unadopted", self.problem_kinds(result))
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)

    def test_write_exitsThree_whenForcedWithoutAdopt(self):
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)

    def test_adopt_listsEveryDroppedItemWithoutEnvValuesAndRefuses_whenNoAcceptFileIsGiven(self):
        # when
        result = self.box.run_link("--write", "--adopt")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.listed_drops(result), EXPECTED_DROPS)
        self.assertNotIn("v1-secret-value", result.stdout + result.stderr)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)

    def test_adopt_refusesAndNamesTheItem_whenOneDropIsMissingFromTheAcceptFile(self):
        # given
        accepted = self.accept_file([item for item in EXPECTED_DROPS if item != "permissions.deny Bash(v1-only-deny:*)"])
        # when
        result = self.box.run_link("--write", "--adopt", "--accept-drops", accepted)
        # then
        self.assertExit(result, 3)
        self.assertIn("not accepted: permissions.deny Bash(v1-only-deny:*)", result.stderr)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)

    def test_adopt_writesSettings_whenEveryDropIsAccepted(self):
        # when
        result = self.adopt()
        # then
        self.assertExit(result, 0)
        live = json.loads(self.box.read_data("settings.json"))
        self.assertNotIn("V1_TOKEN", live["env"])
        self.assertEqual(live["model"], "opus")
        self.assertExit(self.box.run_link("--write"), 0)

    def test_write_proceedsWithoutAdopt_whenLiveHoldsNoOwnedKey(self):
        # given
        self.box.write_data("settings.json", '{"model": "opus"}\n')
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)

    def test_adopt_listsALivePromptHookAndRefuses_whenNoAcceptFileIsGiven(self):
        # given
        prompt_hook = {"type": "prompt", "prompt": "Check the reply."}
        self.box.write_data("settings.json", json.dumps({"hooks": {"Stop": [{"hooks": [prompt_hook]}]}}) + "\n")
        # when
        result = self.box.run_link("--write", "--adopt")
        # then
        self.assertExit(result, 3)
        self.assertIn('adopt drops: hooks.Stop {"prompt": "Check the reply.", "type": "prompt"}', result.stderr)

    def test_cli_exitsWithUsageError_whenAcceptDropsIsGivenWithoutAdopt(self):
        # when
        result = self.box.run_link("--write", "--accept-drops", self.accept_file([]))
        # then
        self.assertExit(result, 2)


class LinkDropListingTest(SwapTestCase):
    def test_dryRun_listsEveryDropWithoutEnvValues_whenNoLinkStateAndLiveOwnedKeysDiffer(self):
        # given the v1 CLAUDE.md in place, which --write would refuse without --force
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        # when
        result = self.box.run_link()
        # then
        self.assertExit(result, 0)
        self.assertEqual(sorted(result.json["dropped"]), EXPECTED_DROPS)
        self.assertNotIn("v1-secret-value", result.stdout + result.stderr)

    def test_dryRun_listsNoDrops_whenKeelHasWrittenTheSettingsBefore(self):
        # given
        self.assertExit(self.adopt(), 0)
        # when
        result = self.box.run_link()
        # then
        self.assertEqual(result.json["dropped"], [])

    def test_adopt_listsTheDropsAndHintsForce_whenTheV1ClaudeMdIsInTheWay(self):
        # given
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        # when
        result = self.box.run_link("--write", "--adopt")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["target-occupied"])
        self.assertEqual(self.listed_drops(result), EXPECTED_DROPS)
        self.assertIn("run: bin/link --write --adopt --force --accept-drops <file>", result.stderr)
        self.assertEqual(self.box.read_data("CLAUDE.md"), "# v1 rules\n")

    def test_adopt_hintsForceInTheAcceptDropsRefusal_whenTheV1ClaudeMdIsInTheWay(self):
        # given
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        # when
        result = self.box.run_link("--write", "--adopt", "--force")
        # then
        self.assertExit(result, 3)
        self.assertIn("run: bin/link --write --adopt --force --accept-drops <file>", result.stderr)
        self.assertEqual(self.box.read_data("CLAUDE.md"), "# v1 rules\n")

    def test_adopt_hintsNoForceInTheAcceptDropsRefusal_whenNothingIsInTheWay(self):
        # when
        result = self.box.run_link("--write", "--adopt")
        # then
        self.assertExit(result, 3)
        self.assertIn("run: bin/link --write --adopt --accept-drops <file>", result.stderr)

    def test_write_hintsOnlyForce_whenSettingsAreAdoptedAndAHandWrittenClaudeMdIsInTheWay(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.box.write_data("CLAUDE.md", "# hand-written rules\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("run: bin/link --write --force", result.stderr)
        [hint] = [line for line in result.stderr.splitlines() if "run: bin/link" in line]
        self.assertNotIn("--adopt", hint)
        self.assertNotIn("--accept-drops", hint)

    def test_write_reportsOnlyTheForceLiftedProblemAsForced_whenAdoptAndForceBothLiftProblems(self):
        # given
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        # when
        result = self.box.run_link("--write", "--adopt", "--force", "--accept-drops", self.accept_file(EXPECTED_DROPS))
        # then
        self.assertExit(result, 0)
        forced = [line for line in result.stderr.splitlines() if line.startswith("link: forced: ")]
        self.assertEqual(len(forced), 1, forced)
        self.assertIn(self.box.data_path("CLAUDE.md"), forced[0])

    def test_write_printsNoCommandHint_whenAProblemNoFlagLifts(self):
        # given a link manifest row whose source is missing
        self.box.write_keel("settings/links.tsv", CORE_LINKS_WITH_DANGLING)
        # when
        result = self.box.run_link("--write", "--adopt")
        # then
        self.assertExit(result, 3)
        self.assertIn("dangling", self.problem_kinds(result))
        self.assertNotIn("run: bin/link", result.stderr)


class LinkSettingsBackupTest(SwapTestCase):
    def test_adopt_copiesLiveSettingsToAPrivateBackup_beforeWriting(self):
        # when
        self.assertExit(self.adopt(), 0)
        # then
        [backup] = self.backups()
        with open(backup, encoding="utf-8") as f:
            self.assertEqual(f.read(), self.v1_text)
        self.assertEqual(os.stat(backup).st_mode & 0o777, 0o600)

    def test_write_backsUpSettingsAgain_whenALaterWriteChangesThem(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.box.write_overlay("settings/90-more.json", json.dumps({"permissions": {"allow": ["Glob"]}}))
        # when
        self.assertExit(self.box.run_link("--write"), 0)
        # then
        self.assertEqual(len(self.backups()), 2)


class LinkUnlinkRestoreTest(SwapTestCase):
    def test_unlink_restoresThePreKeelSettings_afterSeveralWrites(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.box.write_overlay("settings/90-more.json", json.dumps({"permissions": {"allow": ["Glob"]}}))
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)
        self.assertIn("restore-settings", self.ops(result))
        self.assertNotIn("settings.json", result.stderr.split("run:", 1)[1])

    def test_unlink_keepsPostSwapEditsToKeysKeelDoesNotOwn_whileRestoringTheOwnedKeys(self):
        # given a changed value and a new key outside the owned keys, edited after the swap
        self.assertExit(self.adopt(), 0)
        edited = self.box.read_data("settings.json").replace('"model": "opus"', '"statusLine": "user-edit",\n  "model": "sonnet"', 1)
        self.box.write_data("settings.json", edited)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        expected = {"statusLine": "user-edit", **LIVE_V1, "model": "sonnet"}
        self.assertEqual(self.box.read_data("settings.json"), json.dumps(expected, indent=2) + "\n")
        self.assertIn("restore-settings", self.ops(result))

    def test_unlink_keepsAKeyKeelDoesNotOwnRemoved_whenTheUserRemovedItAfterTheSwap(self):
        # given
        self.assertExit(self.adopt(), 0)
        live = json.loads(self.box.read_data("settings.json"))
        del live["model"]
        self.box.write_data("settings.json", json.dumps(live, indent=2) + "\n")
        # when
        self.assertExit(self.box.run_link("--unlink"), 0)
        # then
        expected = {key: value for key, value in LIVE_V1.items() if key != "model"}
        self.assertEqual(json.loads(self.box.read_data("settings.json")), expected)

    def test_unlink_removesAnOwnedKey_whenThePreKeelSettingsLackedIt(self):
        # given pre-keel settings without env, which keel's merge then adds
        without_env = {key: value for key, value in LIVE_V1.items() if key != "env"}
        self.box.write_data("settings.json", json.dumps(without_env, indent=2) + "\n")
        self.assertExit(self.write_adopting_every_drop(), 0)
        self.assertIn("env", json.loads(self.box.read_data("settings.json")))
        # when
        self.assertExit(self.box.run_link("--unlink"), 0)
        # then
        self.assertEqual(json.loads(self.box.read_data("settings.json")), without_env)

    def test_unlink_restoresTheWholePreKeelSettings_whenTheLiveFileIsNotAJsonObject(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.box.write_data("settings.json", "[]\n")
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)
        self.assertIn("restore-settings", self.ops(result))

    def test_unlink_leavesSettingsMissingAndNamesThemInTheV1Command_whenTheUserDeletedTheLiveFile(self):
        # given
        self.assertExit(self.adopt(), 0)
        os.unlink(self.box.data_path("settings.json"))
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertFalse(os.path.exists(self.box.data_path("settings.json")))
        self.assertNotIn("restore-settings", self.ops(result))
        self.assertIn("settings.json", result.stderr.split("run:", 1)[1])

    def test_unlink_leavesSettingsAndListsThemInTheV1Command_whenNoLinkStateIsRecorded(self):
        # given
        self.assertExit(self.adopt(), 0)
        written = self.box.read_data("settings.json")
        os.unlink(self.box.data_path("state/keel/link-state.json"))
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), written)
        self.assertNotIn("restore-settings", self.ops(result))
        self.assertIn("settings.json", result.stderr.split("run:", 1)[1])

    def test_unlink_savesTheLiveSettingsToANewPrivateBackup_beforeRestoring(self):
        # given an edit the user made after keel's write
        self.assertExit(self.adopt(), 0)
        edited = self.box.read_data("settings.json").replace('"model"', '"statusLine": "user-edit",\n  "model"', 1)
        self.box.write_data("settings.json", edited)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        [restore] = [action for action in result.json["actions"] if action["op"] == "restore-settings"]
        with open(restore["live_saved_to"], encoding="utf-8") as f:
            self.assertEqual(f.read(), edited)
        self.assertEqual(os.stat(restore["live_saved_to"]).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(os.path.dirname(restore["live_saved_to"])).st_mode & 0o777, 0o700)

    def test_unlink_keepsThePreKeelSettings_whenRunTwice(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.assertExit(self.box.run_link("--unlink"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)

    def test_unlink_keepsThePreKeelSettings_whenRunTwiceAfterTwoWrites(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.box.write_overlay("settings/90-more.json", json.dumps({"permissions": {"allow": ["Glob"]}}))
        self.assertExit(self.box.run_link("--write"), 0)
        self.assertExit(self.box.run_link("--unlink"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)

    def test_unlink_restoresTheSettingsFromBeforeKeelsFirstSettingsWrite_whenAnEarlierWriteLeftSettingsAlone(self):
        # given live owned keys that already equal the merge, so the first --write leaves settings.json alone
        self.box.write_data("settings.json", "{}\n")
        self.assertExit(self.box.run_link("--write"), 0)
        pre_keel = self.box.read_data("settings.json")
        os.unlink(self.box.data_path("state/keel/link-state.json"))
        self.assertExit(self.box.run_link("--write"), 0)
        self.box.write_overlay("settings/90-more.json", json.dumps({"permissions": {"allow": ["Glob"]}}))
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), pre_keel)

    def test_unlink_restoresTheWholePreKeelSettings_whenTheLiveFileIsNotValidJson(self):
        # given
        self.assertExit(self.adopt(), 0)
        self.box.write_data("settings.json", "{ broken")
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), self.v1_text)
        [restore] = [action for action in result.json["actions"] if action["op"] == "restore-settings"]
        with open(restore["live_saved_to"], encoding="utf-8") as f:
            self.assertEqual(f.read(), "{ broken")

    def test_unlink_leavesSettingsAndPrintsTheV1Command_whenNoBackupExists(self):
        # given
        self.box.write_data("settings.json", '{"model": "opus"}\n')
        self.assertExit(self.box.run_link("--write"), 0)
        written = self.box.read_data("settings.json")
        for backup in self.backups():
            os.unlink(backup)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), written)
        self.assertIn("settings.json", result.stderr.split("run:", 1)[1])


class ListDroppedItemsTest(unittest.TestCase):
    def test_listDroppedItems_labelsAnEnvKeyValueChangedWithoutItsValue_whenTheMergeChangesTheValue(self):
        # when
        dropped = list_dropped_items({"env": {"TOKEN": "old-secret"}}, {"env": {"TOKEN": "new"}})
        # then
        self.assertEqual(dropped, ["env TOKEN (value changed)"])

    def test_listDroppedItems_labelsAnEnvKeyRemoved_whenTheMergeDoesNotDeclareIt(self):
        # when
        dropped = list_dropped_items({"env": {"TOKEN": "old-secret"}}, {"env": {}})
        # then
        self.assertEqual(dropped, ["env TOKEN (removed)"])

    def test_listDroppedItems_keepsNothing_whenMergedHoldsEveryLiveItem(self):
        # given
        live = {"permissions": {"deny": ["a"], "defaultMode": "auto"}, "hooks": {"Stop": [{"hooks": [{"command": "x"}]}]}}
        # when
        dropped = list_dropped_items(live, json.loads(json.dumps(live)))
        # then
        self.assertEqual(dropped, [])

    def test_listDroppedItems_namesACommandHook_whenTheMergeMovesItToAnotherMatcher(self):
        # given
        live = {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "x"}]}]}}
        merged = {"hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "x"}]}]}}
        # when
        dropped = list_dropped_items(live, merged)
        # then
        self.assertEqual(dropped, ["hooks.PreToolUse x"])

    def test_listDroppedItems_namesACommandHook_whenTheMergeChangesItsTimeout(self):
        # given
        live = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x", "timeout": 5}]}]}}
        merged = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x", "timeout": 60}]}]}}
        # when
        dropped = list_dropped_items(live, merged)
        # then
        self.assertEqual(dropped, ["hooks.Stop x"])

    def test_listDroppedItems_keepsAPromptHook_whenMergedHoldsTheSameHook(self):
        # given
        live = {"hooks": {"Stop": [{"hooks": [{"type": "prompt", "prompt": "p"}]}]}}
        # when
        dropped = list_dropped_items(live, json.loads(json.dumps(live)))
        # then
        self.assertEqual(dropped, [])

    def test_listDroppedItems_namesTheWholeKey_whenALiveOwnedKeyIsNotAnObject(self):
        # when
        dropped = list_dropped_items({"permissions": ["Read"]}, {"permissions": {}})
        # then
        self.assertEqual(dropped, ["permissions (not an object)"])

    def test_readAcceptedDrops_refuses_whenTheFileCannotBeRead(self):
        # when / then
        with self.assertRaises(Refused):
            read_accepted_drops("/nonexistent/accepted.txt")


if __name__ == "__main__":
    unittest.main()
