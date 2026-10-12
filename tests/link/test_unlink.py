import json
import os
import subprocess
import unittest

from helpers import LinkTestCase, read_file


class LinkUnlinkTest(LinkTestCase):
    def test_unlink_removesKeelLinksAndGeneratedClaudeMd_whenLinked(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.ops(result).count("remove-link"), 4)
        for target in ("skills/demo", "bin/keel", "commands/hello.md", "CLAUDE.md"):
            self.assertFalse(os.path.lexists(self.box.data_path(target)), target)
        self.assertFalse(os.path.exists(self.box.data_path("state/keel/link-state.json")))

    def test_unlink_removesKeelOwnedSettingsKeysAndKeepsOthers_whenNoSettingsFileExistedBeforeKeel(self):
        # given two writes over a data dir that had no settings.json, and a key the user added in between
        self.assertExit(self.box.run_link("--write"), 0)
        with_user_key = self.box.read_data("settings.json").replace("{", '{\n  "model": "opus",', 1)
        self.box.write_data("settings.json", with_user_key)
        self.box.write_overlay("settings/90-more.json", json.dumps({"permissions": {"allow": ["Glob"]}}))
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(json.loads(self.box.read_data("settings.json")), {"model": "opus"})
        self.assertIn("remove-owned-settings", self.ops(result))
        self.assertIn("settings.json", result.stderr.split("run:", 1)[1])

    def test_unlink_keepsForeignLinkRealFileAndHandWrittenClaudeMd(self):
        # given
        os.makedirs(self.box.data_path("bin"))
        os.symlink("/usr/bin/true", self.box.data_path("bin/keel"))
        self.box.write_data("skills/demo/SKILL.md", "v1 skill\n")
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(result.json["actions"], [])
        self.assertEqual(os.readlink(self.box.data_path("bin/keel")), "/usr/bin/true")
        self.assertEqual(self.box.read_data("skills/demo/SKILL.md"), "v1 skill\n")
        self.assertEqual(self.box.read_data("CLAUDE.md"), "# v1 rules\n")

    def test_unlink_restoresTheMovedAsideClaudeMdByteForByte_afterAForcedWriteAndALaterWrite(self):
        # given a v1 CLAUDE.md with CRLF and no final newline, moved aside by --write --force
        v1 = "# v1 rules\r\n- keep\r\n- this"
        self.box.write_data("CLAUDE.md", v1)
        self.assertExit(self.box.run_link("--write", "--force"), 0)
        self.box.write_overlay("PERSONAL.md", "# changed personal\n")
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("CLAUDE.md"), v1)
        [restore] = [action for action in result.json["actions"] if action["op"] == "restore-claude-md"]
        self.assertEqual(restore["path"], self.box.data_path("CLAUDE.md"))
        self.assertNotIn("CLAUDE.md", result.stderr.split("run:", 1)[1])

    def test_unlink_restoresTheFirstMovedAsideClaudeMd_whenALaterForcedWriteMovedAnotherAside(self):
        # given
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        self.assertExit(self.box.run_link("--write", "--force"), 0)
        self.box.write_data("CLAUDE.md", "# written after the swap\n")
        self.assertExit(self.box.run_link("--write", "--force"), 0)
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("CLAUDE.md"), "# v1 rules\n")

    def test_unlink_leavesABrokenSettingsFileAndNamesItInTheV1Command_whenKeelCreatedIt(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        self.box.write_data("settings.json", "{ broken")
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("settings.json"), "{ broken")
        self.assertNotIn("remove-owned-settings", self.ops(result))
        self.assertIn("settings.json", result.stderr.split("run:", 1)[1])

    def test_unlink_leavesClaudeMdMissingAndNamesItInTheV1Command_whenTheMovedAsideCopyIsGone(self):
        # given
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        self.assertExit(self.box.run_link("--write", "--force"), 0)
        os.unlink(self.only_backup("CLAUDE.md"))
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertFalse(os.path.lexists(self.box.data_path("CLAUDE.md")))
        self.assertNotIn("restore-claude-md", self.ops(result))
        self.assertIn("CLAUDE.md", result.stderr.split("run:", 1)[1])

    def test_unlink_keepsAHandWrittenClaudeMdAndTheMovedAsideCopy_whenTheUserReplacedTheGeneratedFile(self):
        # given
        self.box.write_data("CLAUDE.md", "# v1 rules\n")
        self.assertExit(self.box.run_link("--write", "--force"), 0)
        self.box.write_data("CLAUDE.md", "# written after the swap\n")
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.box.read_data("CLAUDE.md"), "# written after the swap\n")
        self.assertEqual(read_file(self.only_backup("CLAUDE.md")), "# v1 rules\n")
        self.assertNotIn("restore-claude-md", self.ops(result))

    def test_unlink_printsRestoreCommandForPathsTheV1TagHolds_whenDataDirIsARepo(self):
        # given a v1 data repo tagged v1-final holding some of the managed paths
        self.box.write_data("CLAUDE.md", "# v1\n")
        self.box.write_data("settings.json", "{}\n")
        self.box.write_data("skills/demo/SKILL.md", "v1\n")
        self.box.git(self.box.data, "init", "-q")
        self.box.git(self.box.data, "add", "-A")
        self.box.git(self.box.data, "commit", "-q", "-m", "v1")
        self.box.git(self.box.data, "tag", "v1-final")
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertIn(f"git -C {self.box.data} checkout v1-final -- skills/demo CLAUDE.md settings.json\n", result.stderr)

    def test_unlink_printsCommandWithAllPathsAndWarns_whenTagIsMissing(self):
        # when
        result = self.box.run_link("--unlink")
        # then
        self.assertExit(result, 0)
        self.assertIn("tag v1-final not found", result.stderr)
        self.assertIn("checkout v1-final -- skills/demo bin/keel commands/hello.md CLAUDE.md settings.json", result.stderr)

    def test_unlink_printsACommandThatBringsV1Back_whenRunAfterUnlink(self):
        # given v1 tagged, then keel linked over it
        self.box.write_data("CLAUDE.md", "# v1\n")
        self.box.git(self.box.data, "init", "-q")
        self.box.git(self.box.data, "add", "-A")
        self.box.git(self.box.data, "commit", "-q", "-m", "v1")
        self.box.git(self.box.data, "tag", "v1-final")
        os.unlink(self.box.data_path("CLAUDE.md"))
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        result = self.box.run_link("--unlink")
        command = result.stderr.split("run:\n  ", 1)[1].strip()
        subprocess.run(command, shell=True, env=self.box.env(), check=True, capture_output=True)
        # then
        self.assertEqual(self.box.read_data("CLAUDE.md"), "# v1\n")


if __name__ == "__main__":
    unittest.main()
