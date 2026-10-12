import json
import os
import unittest

from helpers import LinkTestCase
from link.settings_json import splice_owned_keys

LIVE_V1 = (
    '{\n'
    '    "model": "opus",\n'
    '    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "v1-stop.sh"}]}]},\n'
    '    "statusLine": {"type":"command","command":"hud --dark"},\n'
    '    "permissions": {\n'
    '        "allow": ["Read"],\n'
    '        "defaultMode": "auto"\n'
    '    },\n'
    '    "theme": "d\u00e9j\u00e0 vu \\u00e9",\n'
    '    "enabledPlugins": [1,2,  3]\n'
    '}'
)
UNOWNED_SPANS = ['"opus"', '{"type":"command","command":"hud --dark"}', '"d\u00e9j\u00e0 vu \\u00e9"', '[1,2,  3]']


class LinkSettingsWriteTest(LinkTestCase):
    def test_write_replacesOnlyOwnedKeysAndKeepsOtherBytes_whenLiveHasV1Settings(self):
        # given
        self.box.write_data("settings.json", LIVE_V1)
        # when
        result = self.write_adopting_every_drop()
        # then
        self.assertExit(result, 0)
        text = self.box.read_data("settings.json")
        for span in UNOWNED_SPANS:
            self.assertIn(span, text)
        self.assertTrue(text.startswith('{\n    "model": "opus",\n    "hooks": '))
        self.assertTrue(text.endswith('"enabledPlugins": [1,2,  3],\n    "env": {\n      "ACME_NOTES_DIR": "' + self.box.data + '/notes"\n    }\n}'))
        live = json.loads(text)
        self.assertEqual(list(live), ["model", "hooks", "statusLine", "permissions", "theme", "enabledPlugins", "env"])
        self.assertEqual(live["hooks"]["PreToolUse"][0]["hooks"][0]["command"], f"python3 {self.box.keel}/hooks/demo.py")
        self.assertNotIn("Stop", live["hooks"])
        self.assertEqual(live["permissions"], {"deny": ["Bash(git push --force:*)", "Bash(rm -rf /:*)"], "ask": ["Bash(git push:*)"]})

    def test_write_createsSettingsWithOwnedKeysOnly_whenLiveFileIsMissing(self):
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertEqual(list(json.loads(self.box.read_data("settings.json"))), ["hooks", "permissions", "env"])
        self.assertEqual(os.stat(self.box.data_path("settings.json")).st_mode & 0o777, 0o600)

    def test_write_keepsFileMode_whenLiveFileExists(self):
        # given
        self.box.write_data("settings.json", "{}")
        os.chmod(self.box.data_path("settings.json"), 0o640)
        # when
        self.assertExit(self.box.run_link("--write"), 0)
        # then
        self.assertEqual(os.stat(self.box.data_path("settings.json")).st_mode & 0o777, 0o640)

    def test_write_mergesStackFragmentInSortedOrder_whenOverlayActivatesStacks(self):
        # given
        self.box.write_overlay("stacks.txt", "# active stacks\nzeta\nalpha\n")
        self.box.write_keel("stacks/alpha/settings.json", json.dumps({"permissions": {"deny": ["alpha-rule", "Bash(git push --force:*)"]}}))
        self.box.write_keel("stacks/zeta/settings.json", json.dumps({"permissions": {"deny": ["zeta-rule"]}}))
        # when
        self.assertExit(self.box.run_link("--write"), 0)
        # then
        deny = json.loads(self.box.read_data("settings.json"))["permissions"]["deny"]
        self.assertEqual(deny, ["Bash(git push --force:*)", "alpha-rule", "zeta-rule", "Bash(rm -rf /:*)"])

    def test_write_letsLaterEnvWinAndWarns_whenFragmentsConflict(self):
        # given
        self.box.write_overlay("settings/90-env.json", json.dumps({"env": {"ACME_NOTES_DIR": "/later"}}))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertEqual(json.loads(self.box.read_data("settings.json"))["env"]["ACME_NOTES_DIR"], "/later")
        self.assertIn("env.ACME_NOTES_DIR is overridden by", result.stderr)
        self.assertNotIn("/later", result.stderr)

    def test_write_refuses_whenFragmentHoldsANonOwnedKey(self):
        # given
        self.box.write_overlay("settings/90-bad.json", json.dumps({"model": "x"}))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("fragments may hold only", result.stderr)

    def test_write_refuses_whenFragmentUsesAnUnknownPlaceholder(self):
        # given
        self.box.write_overlay("settings/90-bad.json", json.dumps({"env": {"X": "{{SECRET}}"}}))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("unknown placeholder", result.stderr)

    def test_write_refuses_whenActiveStackHasNoSettings(self):
        # given
        self.box.write_overlay("stacks.txt", "missing-stack\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("missing-stack", result.stderr)

    def test_write_refuses_whenStackNameIsNotAPlainName(self):
        # given
        self.box.write_overlay("stacks.txt", "../escape\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("invalid stack name", result.stderr)

    def test_write_refusesAndKeepsFile_whenLiveSettingsIsInvalidJson(self):
        # given
        self.box.write_data("settings.json", "{not json")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.box.read_data("settings.json"), "{not json")

    def test_write_refuses_whenOwnedKeysWereEditedSinceTheLastWrite(self):
        # given a hand edit after a write
        self.assertExit(self.box.run_link("--write"), 0)
        self._add_allow_rule_by_hand()
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["settings-drift"])
        self.assertIn("permissions changed since the last --write", result.json["problems"][0]["detail"])
        self.assertIn("hand-added", self.box.read_data("settings.json"))

    def test_write_overwritesHandEdit_whenForced(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        self._add_allow_rule_by_hand()
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 0)
        self.assertNotIn("hand-added", self.box.read_data("settings.json"))
        self.assertExit(self.box.run_link("--write"), 0)

    def test_write_updatesWithoutForce_whenOnlyFragmentsChanged(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        self.box.write_overlay("settings/90-more.json", json.dumps({"permissions": {"allow": ["Read"]}}))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertEqual(json.loads(self.box.read_data("settings.json"))["permissions"]["allow"], ["Read"])

    def test_write_removesLiveOwnedKey_whenNoFragmentDeclaresIt(self):
        # given fragments that declare hooks and permissions but not env
        os.unlink(os.path.join(self.box.overlay, "settings", "50-permissions.json"))
        self.box.write_data("settings.json", '{\n  "env": {"V1_SECRET": "x"},\n  "model": "m"\n}\n')
        # when
        result = self.write_adopting_every_drop()
        # then
        self.assertExit(result, 0)
        text = self.box.read_data("settings.json")
        self.assertNotIn("V1_SECRET", text)
        self.assertEqual(list(json.loads(text)), ["model", "hooks", "permissions"])
        self.assertExit(self.box.run_link("--check"), 0)

    def test_write_refuses_whenUndeclaredOwnedKeyWasAddedByHandSinceTheLastWrite(self):
        # given
        os.unlink(os.path.join(self.box.overlay, "settings", "50-permissions.json"))
        self.assertExit(self.box.run_link("--write"), 0)
        live = json.loads(self.box.read_data("settings.json"))
        live["env"] = {"HAND": "added"}
        self.box.write_data("settings.json", json.dumps(live, indent=2))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["settings-drift"])
        self.assertIn("env changed since the last --write", result.json["problems"][0]["detail"])
        self.assertIn("HAND", self.box.read_data("settings.json"))

    def _add_allow_rule_by_hand(self):
        live = json.loads(self.box.read_data("settings.json"))
        live["permissions"]["allow"] = ["hand-added"]
        self.box.write_data("settings.json", json.dumps(live, indent=2))


class SpliceOwnedKeysTest(unittest.TestCase):
    def test_splice_insertsAbsentKeysAfterLastMember_whenObjectIsMinified(self):
        # when
        spliced = splice_owned_keys('{"a":1,"b":[2]}', {"env": {"K": "v"}})
        # then
        self.assertEqual(spliced, '{"a":1,"b":[2],\n"env": {\n  "K": "v"\n}}')

    def test_splice_insertsIndentedKeys_whenObjectIsEmpty(self):
        # when
        spliced = splice_owned_keys("{}\n", {"hooks": {}, "env": {"K": "v"}})
        # then
        self.assertEqual(spliced, '{\n  "hooks": {},\n  "env": {\n    "K": "v"\n  }\n}\n')

    def test_splice_replacesValueInPlace_whenOwnedKeyIsInTheMiddle(self):
        # when
        spliced = splice_owned_keys('{ "a" : 1 , "env" : {"OLD": "x"} , "z":true }', {"env": {}})
        # then
        self.assertEqual(spliced, '{ "a" : 1 , "env" : {} , "z":true }')

    def test_splice_keepsUnownedKeyNamedLikeANestedOwnedKey(self):
        # when
        spliced = splice_owned_keys('{"nested": {"env": 1}, "env": 2}', {"env": 3})
        # then
        self.assertEqual(spliced, '{"nested": {"env": 1}, "env": 3}')

    def test_splice_removesOwnedMember_whenItIsInTheMiddle(self):
        # when
        spliced = splice_owned_keys('{"a": 1, "env": {"X": 1}, "z": 2}', {})
        # then
        self.assertEqual(spliced, '{"a": 1, "z": 2}')

    def test_splice_removesOwnedMember_whenItIsFirst(self):
        # when
        spliced = splice_owned_keys('{"env": 1, "a": 2}', {})
        # then
        self.assertEqual(spliced, '{"a": 2}')

    def test_splice_removesTrailingOwnedMembers_whenTheyAreLast(self):
        # when
        spliced = splice_owned_keys('{\n  "a": 1,\n  "hooks": {},\n  "env": 2\n}\n', {})
        # then
        self.assertEqual(spliced, '{\n  "a": 1\n}\n')

    def test_splice_leavesEmptyObject_whenTheOnlyMemberIsRemoved(self):
        # when
        spliced = splice_owned_keys('{\n  "env": 1\n}\n', {})
        # then
        self.assertEqual(spliced, "{}\n")

    def test_splice_removesAndInserts_whenLiveAndMergedDeclareDifferentOwnedKeys(self):
        # when
        spliced = splice_owned_keys('{\n  "env": 1\n}', {"hooks": {}})
        # then
        self.assertEqual(spliced, '{\n  "hooks": {}\n}')


if __name__ == "__main__":
    unittest.main()
