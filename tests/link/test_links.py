import json
import os
import shutil
import unittest

from helpers import LinkTestCase, read_file


class LinkWriteLinksTest(LinkTestCase):
    def test_write_createsEveryManifestLink_whenTargetsAreMissing(self):
        # given an empty data dir
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertEqual(os.readlink(self.box.data_path("skills/demo")), os.path.join(self.box.keel, "skills/demo"))
        self.assertEqual(os.readlink(self.box.data_path("bin/keel")), os.path.join(self.box.keel, "bin/keel"))
        self.assertEqual(os.readlink(self.box.data_path("commands/hello.md")), os.path.join(self.box.overlay, "commands/hello.md"))
        self.assertEqual(self.ops(result).count("symlink"), 3)

    def test_write_changesNothing_whenRunTwice(self):
        # given
        self.assertExit(self.box.run_link("--write"), 0)
        # when
        second = self.box.run_link("--write")
        # then
        self.assertExit(second, 0)
        self.assertEqual(second.json["actions"], [])

    def test_write_replacesLink_whenKeelLinkPointsAtAnOldKeelPath(self):
        # given a keel link left over from an earlier manifest
        os.makedirs(self.box.data_path("skills"))
        os.symlink(os.path.join(self.box.keel, "skills/old"), self.box.data_path("skills/demo"))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertIn({"op": "replace-link", "path": self.box.data_path("skills/demo")}, result.json["actions"])
        self.assertEqual(os.readlink(self.box.data_path("skills/demo")), os.path.join(self.box.keel, "skills/demo"))

    def test_write_refusesAndWritesNothing_whenTargetIsARegularFile(self):
        # given a v1 file where a link should go
        self.box.write_data("bin/keel", "v1 content\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["target-occupied"])
        self.assertEqual(self.box.read_data("bin/keel"), "v1 content\n")
        self.assertFalse(os.path.lexists(self.box.data_path("skills/demo")))
        self.assertFalse(os.path.exists(self.box.data_path("CLAUDE.md")))

    def test_write_refuses_whenTargetIsARealDirectoryWithoutForce(self):
        # given
        self.box.write_data("skills/demo/SKILL.md", "v1 skill\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["target-occupied"])
        self.assertEqual(self.box.read_data("skills/demo/SKILL.md"), "v1 skill\n")

    def test_write_movesRealDirectoryAsideAndLinks_whenForced(self):
        # given
        self.box.write_data("skills/demo/SKILL.md", "v1 skill\n")
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 0)
        self.assertIn({"op": "symlink", "path": self.box.data_path("skills/demo")}, result.json["actions"])
        self.assertEqual(os.readlink(self.box.data_path("skills/demo")), os.path.join(self.box.keel, "skills/demo"))
        self.assertEqual(read_file(self.only_backup("skills/demo/SKILL.md")), "v1 skill\n")
        self.assertIn("moves it to", result.stderr)

    def test_write_movesRegularFileAsideAndLinks_whenForced(self):
        # given
        self.box.write_data("bin/keel", "v1 content\n")
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 0)
        self.assertEqual(os.readlink(self.box.data_path("bin/keel")), os.path.join(self.box.keel, "bin/keel"))
        self.assertEqual(read_file(self.only_backup("bin/keel")), "v1 content\n")

    def test_write_refuses_whenTargetIsAForeignLinkWithoutForce(self):
        # given
        os.makedirs(self.box.data_path("bin"))
        os.symlink("/usr/bin/true", self.box.data_path("bin/keel"))
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["link-wrong"])
        self.assertEqual(os.readlink(self.box.data_path("bin/keel")), "/usr/bin/true")

    def test_write_replacesForeignLink_whenForced(self):
        # given
        os.makedirs(self.box.data_path("bin"))
        os.symlink("/usr/bin/true", self.box.data_path("bin/keel"))
        # when
        result = self.box.run_link("--write", "--force")
        # then
        self.assertExit(result, 0)
        self.assertEqual(os.readlink(self.box.data_path("bin/keel")), os.path.join(self.box.keel, "bin/keel"))
        self.assertEqual(os.readlink(self.only_backup("bin/keel")), "/usr/bin/true")

    def test_write_refuses_whenLinkSourceDoesNotExist(self):
        # given
        self.box.write_keel("settings/links.tsv", "source\ttarget\n{{KEEL}}/skills/absent\tskills/absent\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertEqual(self.problem_kinds(result), ["dangling"])
        self.assertFalse(os.path.lexists(self.box.data_path("skills/absent")))

    def test_write_refuses_whenTargetEscapesTheDataDir(self):
        for target in ("../escape", "/abs/path", "skills/../../x"):
            with self.subTest(target=target):
                # given
                self.box.write_keel("settings/links.tsv", f"source\ttarget\n{{{{KEEL}}}}/bin/keel\t{target}\n")
                # when
                result = self.box.run_link("--write")
                # then
                self.assertExit(result, 3)
                self.assertIn("target must be a relative path", result.stderr)

    def test_write_refuses_whenManifestUsesAnUnknownPlaceholder(self):
        # given
        self.box.write_keel("settings/links.tsv", "source\ttarget\n{{HOME}}/x\tx\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("unknown placeholder {{HOME}}", result.stderr)

    def test_write_refuses_whenTwoManifestsDeclareTheSameTarget(self):
        # given
        self.box.write_overlay("links.tsv", "source\ttarget\n{{OVERLAY}}/commands/hello.md\tbin/keel\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("already declared", result.stderr)

    def test_write_refuses_whenManifestHeaderIsWrong(self):
        # given
        self.box.write_keel("settings/links.tsv", "from\tto\n{{KEEL}}/bin/keel\tbin/keel\n")
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("header must be exactly", result.stderr)

    def test_write_linksOnlyKeelEntries_whenOverlayDirIsMissing(self):
        # given
        shutil.rmtree(self.box.overlay)
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)
        self.assertTrue(os.path.islink(self.box.data_path("bin/keel")))
        self.assertFalse(os.path.lexists(self.box.data_path("commands/hello.md")))


class LinkWorktreeGuardTest(LinkTestCase):
    def setUp(self):
        super().setUp()
        self.box.git(self.box.keel, "init", "-q")
        self.box.git(self.box.keel, "add", "-A")
        self.box.git(self.box.keel, "commit", "-q", "-m", "init")
        self.worktree = os.path.join(self.box.root, "keel-wt")
        self.box.git(self.box.keel, "worktree", "add", "-q", self.worktree)

    def run_from_worktree(self, *args):
        self.box.keel = self.worktree
        return self.box.run_link(*args)

    def write_unadopted_settings(self):
        self.box.write_data("settings.json", json.dumps({"permissions": {"allow": ["Read"]}}) + "\n")

    def test_write_refuses_whenKeelHomeIsALinkedWorktree(self):
        # when
        result = self.run_from_worktree("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("linked worktree", result.stderr)
        self.assertFalse(os.path.lexists(self.box.data_path("bin/keel")))

    def test_write_proceeds_whenWorktreeIsExplicitlyAllowed(self):
        # when
        result = self.run_from_worktree("--write", "--allow-worktree")
        # then
        self.assertExit(result, 0)
        self.assertEqual(os.readlink(self.box.data_path("bin/keel")), os.path.join(self.worktree, "bin/keel"))

    def test_write_hintsAllowWorktree_whenRefusedFromAnAllowedLinkedWorktree(self):
        # given
        self.write_unadopted_settings()
        # when
        result = self.run_from_worktree("--write", "--allow-worktree")
        # then
        self.assertExit(result, 3)
        self.assertIn("settings-unadopted", self.problem_kinds(result))
        self.assertIn("run: bin/link --write --adopt --accept-drops <file> --allow-worktree", result.stderr)

    def test_adopt_hintsAllowWorktreeInTheAcceptDropsRefusal_whenRunFromAnAllowedLinkedWorktree(self):
        # given
        self.write_unadopted_settings()
        # when
        result = self.run_from_worktree("--write", "--adopt", "--allow-worktree")
        # then
        self.assertExit(result, 3)
        self.assertIn("run: bin/link --write --adopt --accept-drops <file> --allow-worktree", result.stderr)

    def test_write_hintsNoAllowWorktree_whenRefusedFromTheMainCheckout(self):
        # given
        self.write_unadopted_settings()
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 3)
        self.assertIn("run: bin/link --write --adopt --accept-drops <file>", result.stderr)
        self.assertNotIn("--allow-worktree", result.stderr)

    def test_write_proceeds_whenKeelHomeIsTheMainCheckout(self):
        # when
        result = self.box.run_link("--write")
        # then
        self.assertExit(result, 0)


class LinkDryRunAndUsageTest(LinkTestCase):
    def test_dryRun_listsPlannedActionsAndWritesNothing_whenNoFlagIsGiven(self):
        # when
        result = self.box.run_link()
        # then
        self.assertExit(result, 0)
        self.assertEqual(self.ops(result), ["merge-settings", "set-hooks-path", "symlink", "symlink", "symlink", "write-claude-md"])
        self.assertEqual(os.listdir(self.box.data), [])

    def test_cli_exitsWithUsageError_whenForceIsGivenWithoutWrite(self):
        # when
        result = self.box.run_link("--check", "--force")
        # then
        self.assertExit(result, 2)

    def test_cli_exitsWithUsageError_whenTwoModesAreGiven(self):
        # when
        result = self.box.run_link("--check", "--write")
        # then
        self.assertExit(result, 2)


if __name__ == "__main__":
    unittest.main()
